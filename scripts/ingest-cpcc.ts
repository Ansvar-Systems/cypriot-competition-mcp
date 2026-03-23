/**
 * Ingestion crawler for the CPCC (Commission for the Protection of Competition — Cyprus).
 * Fetches decisions and mergers from competition.gov.cy and populates the SQLite database.
 *
 * Usage:
 *   npx tsx scripts/ingest-cpcc.ts [--resume] [--dry-run] [--force]
 *
 * Flags:
 *   --resume   Skip decisions/mergers already in the database (default: skip existing)
 *   --dry-run  Parse and log but do not write to the database
 *   --force    Drop and recreate all tables before ingestion
 *
 * Environment:
 *   CPCCY_DB_PATH  Path to the SQLite database (default: data/cpc-cy.db)
 *
 * Data sources (competition.gov.cy, Lotus Domino backend):
 *   - Main decisions listing (EN): desicions_en/desicions_en
 *   - Main decisions listing (GR): desicions_gr/desicions_gr
 *   - Category pages: page27 (cartels), page28 (abuse of dominance),
 *     page31 (mergers), page29 (economic dependence)
 *   - Archive pages: page{N}_arch_{lang}
 *   - Individual decisions: /All/{HASH}?OpenDocument
 *   - PDF attachments: {HASH}/$file/{filename}.pdf
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["CPCCY_DB_PATH"] ?? "data/cpc-cy.db";
const BASE_URL = "https://www.competition.gov.cy";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const PROGRESS_FILE = "data/.ingest-cpcc-progress.json";

/** Category pages on competition.gov.cy (EN + GR). */
const CATEGORY_PAGES: CategoryDef[] = [
  // Main combined listing
  { type: "all", lang: "en", path: "/competition/Competition.nsf/desicions_en/desicions_en" },
  { type: "all", lang: "gr", path: "/competition/competition.nsf/desicions_gr/desicions_gr" },
  // Category-specific current pages
  { type: "cartel", lang: "en", path: "/competition/competition.nsf/page27_en/page27_en?OpenDocument" },
  { type: "cartel", lang: "gr", path: "/competition/competition.nsf/page27_gr/page27_gr?OpenDocument" },
  { type: "abuse_of_dominance", lang: "en", path: "/competition/competition.nsf/page28_en/page28_en?OpenDocument" },
  { type: "abuse_of_dominance", lang: "gr", path: "/competition/competition.nsf/page28_gr/page28_gr?OpenDocument" },
  { type: "merger", lang: "en", path: "/competition/competition.nsf/page31_en/page31_en?OpenDocument" },
  { type: "merger", lang: "gr", path: "/competition/competition.nsf/page31_gr/page31_gr?OpenDocument" },
  { type: "economic_dependence", lang: "en", path: "/competition/competition.nsf/page29_en/page29_en?OpenDocument" },
  { type: "economic_dependence", lang: "gr", path: "/competition/competition.nsf/page29_gr/page29_gr?OpenDocument" },
  // Archive pages
  { type: "cartel", lang: "en", path: "/competition/competition.nsf/page27_arch_en/page27_arch_en?OpenDocument" },
  { type: "cartel", lang: "gr", path: "/competition/competition.nsf/page27_arch_gr/page27_arch_gr?OpenDocument" },
  { type: "abuse_of_dominance", lang: "en", path: "/competition/competition.nsf/page28_arch_en/page28_arch_en?OpenDocument" },
  { type: "abuse_of_dominance", lang: "gr", path: "/competition/competition.nsf/page28_arch_gr/page28_arch_gr?OpenDocument" },
  { type: "merger", lang: "en", path: "/competition/competition.nsf/page31_arch_en/page31_arch_en?OpenDocument" },
  { type: "merger", lang: "gr", path: "/competition/competition.nsf/page31_arch_gr/page31_arch_gr?OpenDocument" },
  { type: "economic_dependence", lang: "en", path: "/competition/competition.nsf/page29_arch_en/page29_arch_en?OpenDocument" },
  { type: "economic_dependence", lang: "gr", path: "/competition/competition.nsf/page29_arch_gr/page29_arch_gr?OpenDocument" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CategoryDef {
  type: "all" | "cartel" | "abuse_of_dominance" | "merger" | "economic_dependence";
  lang: "en" | "gr";
  path: string;
}

interface ListingEntry {
  /** Decision number as shown on the listing page (e.g. "CPC: 69/2025" or "ΕΠΑ: 69/2025") */
  rawNumber: string;
  /** Normalised case number (e.g. "69/2025") */
  caseNumber: string;
  /** Title / description from the listing page */
  title: string;
  /** Absolute URL to the individual decision page */
  detailUrl: string;
  /** Detected decision type from category page */
  type: string;
  /** Language of the listing source */
  lang: "en" | "gr";
}

interface DecisionDetail {
  date: string | null;
  pdfUrl: string | null;
  fullText: string;
  parties: string[];
  legalBasis: string[];
  outcome: string | null;
  fineAmount: number | null;
  acquiringParty: string | null;
  target: string | null;
  sector: string | null;
  titleGr: string | null;
}

interface ProgressState {
  completedUrls: string[];
  lastRun: string;
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const FLAG_RESUME = args.includes("--resume");
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_FORCE = args.includes("--force");

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function warn(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  console.warn(`[${ts}] WARN: ${msg}`);
}

function error(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Rate-limited HTTP fetch with retry
// ---------------------------------------------------------------------------

let lastFetchTime = 0;

async function rateLimitedFetch(url: string): Promise<string> {
  const now = Date.now();
  const elapsed = now - lastFetchTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastFetchTime = Date.now();
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Ansvar-CPCC-Crawler/1.0 (compliance research; hello@ansvar.ai)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,el;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
      }

      return await resp.text();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        warn(`Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${lastError.message}. Retrying in ${backoff}ms...`);
        await sleep(backoff);
      }
    }
  }

  throw new Error(`All ${MAX_RETRIES} attempts failed for ${url}: ${lastError?.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Progress persistence (for --resume)
// ---------------------------------------------------------------------------

function loadProgress(): ProgressState {
  const absPath = resolve(PROGRESS_FILE);
  if (existsSync(absPath)) {
    try {
      return JSON.parse(readFileSync(absPath, "utf-8")) as ProgressState;
    } catch {
      // Corrupted file — start fresh
    }
  }
  return { completedUrls: [], lastRun: new Date().toISOString() };
}

function saveProgress(state: ProgressState): void {
  const absPath = resolve(PROGRESS_FILE);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(absPath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Case number parsing
// ---------------------------------------------------------------------------

/**
 * Extract and normalise a case number from the raw listing text.
 * Handles both English ("CPC: 69/2025", "Decision CPC: 69/2025")
 * and Greek ("ΕΠΑ: 69/2025", "Απόφαση ΕΠΑ: 69/2025") formats.
 * Also handles merger-prefixed numbers like "M-05/2022".
 */
function parseCaseNumber(raw: string): string | null {
  // Try "CPC: NN/YYYY" or "ΕΠΑ: NN/YYYY" pattern (with optional "Decision"/"Απόφαση" prefix)
  const stdMatch = raw.match(/(?:CPC|ΕΠΑ)\s*[:.]?\s*(\d+\/\d{4})/i);
  if (stdMatch?.[1]) return stdMatch[1];

  // Try merger-style "M-NN/YYYY"
  const mergerMatch = raw.match(/(M-\d+\/\d{4})/i);
  if (mergerMatch?.[1]) return mergerMatch[1];

  // Bare number/year
  const bareMatch = raw.match(/(\d{1,3}\/\d{4})/);
  if (bareMatch?.[1]) return bareMatch[1];

  return null;
}

/**
 * Determine if this is a merger/concentration based on title keywords.
 */
function isMergerByTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    lower.includes("concentration") ||
    lower.includes("acquisition") ||
    lower.includes("merger") ||
    lower.includes("joint control") ||
    lower.includes("joint venture") ||
    lower.includes("συγκέντρωση") ||
    lower.includes("απόκτηση") ||
    lower.includes("εξαγορά") ||
    lower.includes("συγχώνευση") ||
    lower.includes("κοινό έλεγχο") ||
    lower.includes("κοινοποίηση συγκέντρωσης")
  );
}

// ---------------------------------------------------------------------------
// Listing page parser
// ---------------------------------------------------------------------------

/**
 * Parse a listing or category page to extract decision entries.
 * The site uses bulleted link lists — each <a> inside the content area
 * links to an individual decision page.
 */
function parseListingPage(html: string, categoryType: string, lang: "en" | "gr"): ListingEntry[] {
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];
  const seen = new Set<string>();

  // Decision links live inside the main content area.
  // They follow the pattern: /competition/competition.nsf/All/{HASH}?OpenDocument
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href.includes("/All/") || !href.includes("OpenDocument")) return;

    const linkText = $(el).text().trim();
    if (!linkText) return;

    const caseNumber = parseCaseNumber(linkText);
    if (!caseNumber) return;

    // Skip duplicates on the same page
    if (seen.has(caseNumber)) return;
    seen.add(caseNumber);

    // Normalise the URL
    let detailUrl = href;
    if (detailUrl.startsWith("../") || detailUrl.startsWith("/")) {
      detailUrl = new URL(detailUrl, BASE_URL + "/competition/competition.nsf/").href;
    }
    if (!detailUrl.startsWith("http")) {
      detailUrl = BASE_URL + (detailUrl.startsWith("/") ? "" : "/") + detailUrl;
    }

    // Detect type from category or title
    let type = categoryType;
    if (type === "all") {
      if (isMergerByTitle(linkText)) {
        type = "merger";
      } else if (linkText.toLowerCase().includes("complaint") || linkText.toLowerCase().includes("καταγγελία")) {
        type = "complaint";
      } else if (linkText.toLowerCase().includes("ex officio") || linkText.toLowerCase().includes("αυτεπάγγελτη")) {
        type = "ex_officio";
      } else {
        type = "decision";
      }
    }

    entries.push({
      rawNumber: linkText.slice(0, 80),
      caseNumber,
      title: linkText,
      detailUrl,
      type,
      lang,
    });
  });

  return entries;
}

/**
 * For archive pages with accordion (Spry) widgets, try expanding all sections
 * by appending Expand parameters and re-fetching.
 */
async function fetchExpandedArchive(basePath: string): Promise<string> {
  // Try with multiple Expand params to open all accordion sections
  const separator = basePath.includes("?") ? "&" : "?";
  const expandParams = Array.from({ length: 25 }, (_, i) => `Expand=${i + 1}`).join("&");
  const expandedUrl = `${BASE_URL}${basePath}${separator}${expandParams}`;
  return rateLimitedFetch(expandedUrl);
}

// ---------------------------------------------------------------------------
// Decision detail page parser
// ---------------------------------------------------------------------------

function parseDecisionDetail(html: string, lang: "en" | "gr"): DecisionDetail {
  const $ = cheerio.load(html);

  // Extract date — look for patterns like DD/MM/YYYY in the body
  let date: string | null = null;
  const bodyText = $("body").text();
  const dateMatch = bodyText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    const [, day, month, year] = dateMatch;
    date = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  // Extract PDF link
  let pdfUrl: string | null = null;
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.toLowerCase().endsWith(".pdf") || href.includes("$file")) {
      pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href.startsWith("/") ? "" : "/competition/competition.nsf/All/"}${href}`;
    }
  });

  // Extract full text from the page content (excluding navigation)
  // The main content area typically follows the breadcrumb
  const contentText = extractMainContent($);

  // Extract parties from the title/description
  const parties = extractParties(contentText);

  // Extract legal basis references
  const legalBasis = extractLegalBasis(contentText);

  // Detect outcome from text
  const outcome = detectOutcome(contentText);

  // Detect fine amount
  const fineAmount = extractFineAmount(contentText);

  // For mergers: extract acquiring party and target
  const { acquiringParty, target } = extractMergerParties(contentText);

  // Detect sector
  const sector = detectSector(contentText);

  // Greek title (if on Greek page)
  let titleGr: string | null = null;
  if (lang === "gr") {
    const h2 = $("h2, .decision-title, td font b").first().text().trim();
    if (h2) titleGr = h2;
  }

  return {
    date,
    pdfUrl,
    fullText: contentText || "(No text content available — decision in PDF format)",
    parties,
    legalBasis,
    outcome,
    fineAmount,
    acquiringParty,
    target,
    sector,
    titleGr,
  };
}

function extractMainContent($: cheerio.CheerioAPI): string {
  // Remove navigation, headers, footers
  $("nav, header, footer, script, style, .navigation, #menu, #nav").remove();

  // The Lotus Domino pages use table layouts. The main content is usually
  // in the deepest nested table cells.
  let content = "";

  // Try to find the main content area — look for text after the breadcrumb
  const allText = $("body").text();

  // Clean up whitespace
  content = allText
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();

  // Remove common navigation/chrome text
  const navPhrases = [
    "You are here:",
    "Homepage",
    "Print this page",
    "Back",
    "Anti-competitive Agreements",
    "Collusions",
    "Dominant Position",
    "Mergers",
    "Economic Dependence",
    "COMMISSION FOR THE PROTECTION OF COMPETITION",
    "ΕΠΙΤΡΟΠΗ ΠΡΟΣΤΑΣΙΑΣ ΤΟΥ ΑΝΤΑΓΩΝΙΣΜΟΥ",
    "Copyright ©",
    "Design & Development",
    "Department of Information Technology Services",
    "search",
    "Search",
    "Last Modified:",
    "Accessibility",
    "Disclaimer",
    "Site Map",
    "Contact Us",
    "Links",
  ];

  for (const phrase of navPhrases) {
    // Remove lines that are just navigation phrases
    content = content.replace(new RegExp(`^.*${escapeRegex(phrase)}.*$`, "gm"), "");
  }

  return content.replace(/\s+/g, " ").trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractParties(text: string): string[] {
  const parties: string[] = [];
  const lower = text.toLowerCase();

  // Match company names — look for common corporate suffixes
  const corpPatterns = [
    /(?:against|κατά)\s+(.+?)(?:\s+for\s+|\s+για\s+|$)/gi,
    /([A-Z][A-Za-z\s.&]+(?:Ltd|Limited|PLC|plc|S\.A\.|SA|GmbH|Inc\.|LLC|B\.V\.|AG|S\.p\.A\.|PJSC|AB|A\/S|ApS|SAS|S\.à\.r\.l\.|S\.C\.A\.))/g,
  ];

  for (const pattern of corpPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const party = match[1]?.trim();
      if (party && party.length > 3 && !parties.includes(party)) {
        parties.push(party);
      }
    }
  }

  return parties.slice(0, 10); // Cap at 10 parties
}

function extractLegalBasis(text: string): string[] {
  const refs: string[] = [];
  const patterns = [
    /(?:Law\s+)?13\(I\)\/(?:2008|2022)\s*(?:Article|Section|Άρθρο)?\s*\d+(?:\(\d+\))?/gi,
    /(?:Section|Άρθρο)\s+\d+(?:\(\d+\))?\s+(?:of\s+)?(?:Law\s+)?(?:13\(I\)\/(?:2008|2022)|207\/89)/gi,
    /(?:Article|Άρθρο)\s+(?:101|102)\s*(?:\(\d+\))?\s*(?:of\s+the\s+)?TFEU/gi,
    /(?:Article|Άρθρο)\s+(?:101|102)\s*(?:\(\d+\))?\s*(?:of\s+the\s+)?(?:Treaty|Συνθήκη)/gi,
    /Ν(?:όμος)?\.?\s*13\(Ι\)\/(?:2008|2022)/gi,
    /Law\s+207\/89/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const ref = match[0].trim();
      if (!refs.includes(ref)) refs.push(ref);
    }
  }

  return refs;
}

function detectOutcome(text: string): string | null {
  const lower = text.toLowerCase();

  if (lower.includes("fine imposed") || lower.includes("πρόστιμο")) return "fine";
  if (lower.includes("prohibited") || lower.includes("απαγόρευση")) return "prohibited";
  if (lower.includes("cleared with conditions") || lower.includes("υπό όρους")) return "cleared_with_conditions";
  if (lower.includes("cleared in phase 1") || lower.includes("phase 1") || lower.includes("φάση 1")) return "cleared_phase1";
  if (lower.includes("cleared in phase 2") || lower.includes("phase 2") || lower.includes("φάση 2")) return "cleared_phase2";
  if (lower.includes("cleared") || lower.includes("εγκρίθηκε") || lower.includes("δεν διαπιστώθηκε παράβαση")) return "cleared";
  if (lower.includes("rejected") || lower.includes("απορρίφθηκε")) return "rejected";
  if (lower.includes("withdrawn") || lower.includes("ανακλήθηκε")) return "withdrawn";
  if (lower.includes("commitments") || lower.includes("δεσμεύσεις")) return "commitments";
  if (lower.includes("sector inquiry") || lower.includes("κλαδική έρευνα")) return "sector_inquiry";

  return null;
}

function extractFineAmount(text: string): number | null {
  // Match EUR/€ amounts
  const patterns = [
    /(?:EUR|€)\s*([\d,.]+)\s*(?:million|εκ(?:ατ)?\.?)/gi,
    /(?:EUR|€)\s*([\d,.]+)/gi,
    /(?:fine|πρόστιμο)\s*(?:of)?\s*(?:EUR|€)\s*([\d,.]+)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let amount = parseFloat(match[1].replace(/,/g, ""));
      if (text.toLowerCase().includes("million") || text.includes("εκατ")) {
        amount *= 1_000_000;
      }
      return amount;
    }
  }

  return null;
}

function extractMergerParties(text: string): { acquiringParty: string | null; target: string | null } {
  // "acquisition of ... by ..." or "acquisition of ... from ..."
  const acqMatch = text.match(
    /(?:acquisition|απόκτηση)\s+(?:of\s+)?(?:the\s+)?(?:share\s+capital\s+of\s+)?(.+?)(?:\s+by\s+|\s+from\s+|\s+από\s+)(.+?)(?:\s*[,.;]|\s+via\s+|\s+through\s+)/i,
  );

  if (acqMatch) {
    return {
      target: acqMatch[1]?.trim().slice(0, 200) ?? null,
      acquiringParty: acqMatch[2]?.trim().slice(0, 200) ?? null,
    };
  }

  return { acquiringParty: null, target: null };
}

function detectSector(text: string): string | null {
  const lower = text.toLowerCase();
  const sectorMap: Array<[string[], string]> = [
    [["bank", "τράπεζ", "financial", "χρηματοοικονομ", "insurance", "ασφαλ", "loan", "δάνει"], "banking"],
    [["telecom", "τηλεπικοινων", "mobile", "broadband", "cable", "internet"], "telecommunications"],
    [["energy", "ενέργει", "electricity", "ηλεκτρ", "petroleum", "πετρέλαι", "gas", "φυσικό αέριο", "renewable"], "energy"],
    [["tourism", "τουρισμ", "hotel", "ξενοδοχ", "airport", "αεροδρόμ", "airline", "travel"], "tourism"],
    [["retail", "λιανικ", "supermarket", "σούπερ μάρκετ", "food retail", "grocery"], "retail"],
    [["pharma", "φαρμακ", "health", "υγεί", "medical", "ιατρ", "hospital", "νοσοκομ"], "pharmaceuticals"],
    [["shipping", "ναυτιλ", "maritime", "port", "λιμάν", "stevedoring"], "shipping"],
    [["technology", "τεχνολογ", "software", "λογισμικ", "digital", "ψηφιακ", "cyber", "IT "], "technology"],
    [["construction", "κατασκευ", "building", "οικοδομ", "cement", "τσιμέντ", "brick"], "construction"],
    [["dairy", "γαλακτοκομ", "food", "τρόφιμ", "agriculture", "αγροτ", "beverage", "ποτ"], "food_and_agriculture"],
    [["media", "μέσα ενημέρωσ", "newspaper", "εφημερίδ", "publishing", "εκδοτ", "advertising"], "media"],
    [["real estate", "ακίνητ", "property", "hotel"], "real_estate"],
    [["transport", "μεταφορ", "logistics", "εφοδιαστ"], "transport"],
    [["oil", "πετρελαι", "gas", "LPG", "fuel", "καύσιμ"], "oil_and_gas"],
  ];

  for (const [keywords, sector] of sectorMap) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return sector;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (FLAG_FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log(`Deleted existing database: ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function caseExists(db: Database.Database, table: "decisions" | "mergers", caseNumber: string): boolean {
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE case_number = ? LIMIT 1`).get(caseNumber);
  return row !== undefined;
}

function insertDecision(
  db: Database.Database,
  entry: ListingEntry,
  detail: DecisionDetail,
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Build a summary from the first ~500 chars of full text
  const summary = detail.fullText.slice(0, 500).replace(/\s+/g, " ").trim();

  stmt.run(
    entry.caseNumber,
    entry.title,
    detail.date,
    entry.type,
    detail.sector,
    detail.parties.length > 0 ? JSON.stringify(detail.parties) : null,
    summary,
    detail.fullText,
    detail.outcome,
    detail.fineAmount,
    detail.legalBasis.length > 0 ? JSON.stringify(detail.legalBasis) : null,
    "final",
  );
}

function insertMerger(
  db: Database.Database,
  entry: ListingEntry,
  detail: DecisionDetail,
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const summary = detail.fullText.slice(0, 500).replace(/\s+/g, " ").trim();

  stmt.run(
    entry.caseNumber,
    entry.title,
    detail.date,
    detail.sector,
    detail.acquiringParty,
    detail.target,
    summary,
    detail.fullText,
    detail.outcome,
    null, // Turnover not available from page scraping
  );
}

function updateSectorCounts(db: Database.Database): void {
  // Collect unique sectors from both tables
  const sectors = new Set<string>();
  const dRows = db.prepare("SELECT DISTINCT sector FROM decisions WHERE sector IS NOT NULL").all() as Array<{ sector: string }>;
  const mRows = db.prepare("SELECT DISTINCT sector FROM mergers WHERE sector IS NOT NULL").all() as Array<{ sector: string }>;
  for (const r of dRows) sectors.add(r.sector);
  for (const r of mRows) sectors.add(r.sector);

  const upsert = db.prepare(`
    INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET decision_count = excluded.decision_count, merger_count = excluded.merger_count
  `);

  for (const sector of sectors) {
    const dCount = (db.prepare("SELECT count(*) as cnt FROM decisions WHERE sector = ?").get(sector) as { cnt: number }).cnt;
    const mCount = (db.prepare("SELECT count(*) as cnt FROM mergers WHERE sector = ?").get(sector) as { cnt: number }).cnt;
    const displayName = sector.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    upsert.run(sector, displayName, displayName, null, dCount, mCount);
  }
}

// ---------------------------------------------------------------------------
// Main crawl orchestration
// ---------------------------------------------------------------------------

async function crawl(): Promise<void> {
  log("=== CPCC Ingestion Crawler ===");
  log(`Database: ${DB_PATH}`);
  log(`Flags: resume=${FLAG_RESUME}, dry-run=${FLAG_DRY_RUN}, force=${FLAG_FORCE}`);

  // Initialise database
  let db: Database.Database | null = null;
  if (!FLAG_DRY_RUN) {
    db = initDb();
    log("Database initialised");
  }

  // Load resume state
  const progress = FLAG_RESUME ? loadProgress() : { completedUrls: [], lastRun: new Date().toISOString() };
  const completedSet = new Set(progress.completedUrls);

  // Phase 1: Collect all decision entries from listing pages
  log("\n--- Phase 1: Collecting decision entries from listing pages ---");
  const allEntries = new Map<string, ListingEntry>();

  for (const cat of CATEGORY_PAGES) {
    const url = `${BASE_URL}${cat.path}`;
    log(`Fetching ${cat.type} (${cat.lang}): ${cat.path}`);

    try {
      let html: string;
      if (cat.path.includes("_arch_")) {
        // Archive pages need expansion
        html = await fetchExpandedArchive(cat.path);
      } else {
        html = await rateLimitedFetch(url);
      }

      const entries = parseListingPage(html, cat.type, cat.lang);
      log(`  Found ${entries.length} entries`);

      for (const entry of entries) {
        const existing = allEntries.get(entry.caseNumber);
        if (!existing) {
          allEntries.set(entry.caseNumber, entry);
        } else {
          // Prefer English title, but keep the more specific type
          if (entry.lang === "en" && existing.lang === "gr") {
            allEntries.set(entry.caseNumber, { ...entry, type: existing.type !== "all" && existing.type !== "decision" ? existing.type : entry.type });
          } else if (existing.type === "all" || existing.type === "decision") {
            // Keep existing URL/lang but upgrade the type
            if (entry.type !== "all" && entry.type !== "decision") {
              existing.type = entry.type;
            }
          }
        }
      }
    } catch (err) {
      warn(`Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`\nTotal unique decisions found: ${allEntries.size}`);

  // Phase 2: Fetch detail pages and persist
  log("\n--- Phase 2: Fetching individual decision pages ---");
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let idx = 0;

  const sortedEntries = [...allEntries.values()].sort((a, b) => {
    // Sort by year descending, then case number descending
    const yearA = parseInt(a.caseNumber.split("/")[1] ?? "0");
    const yearB = parseInt(b.caseNumber.split("/")[1] ?? "0");
    if (yearA !== yearB) return yearB - yearA;
    const numA = parseInt(a.caseNumber.split("/")[0] ?? "0");
    const numB = parseInt(b.caseNumber.split("/")[0] ?? "0");
    return numB - numA;
  });

  for (const entry of sortedEntries) {
    idx++;
    const table = isMergerByTitle(entry.title) || entry.type === "merger" ? "mergers" : "decisions";

    // Skip if already done (--resume)
    if (FLAG_RESUME && completedSet.has(entry.detailUrl)) {
      skipped++;
      continue;
    }

    // Skip if already in DB (default behaviour)
    if (db && caseExists(db, table, entry.caseNumber)) {
      skipped++;
      continue;
    }

    log(`[${idx}/${sortedEntries.length}] ${entry.caseNumber}: ${entry.title.slice(0, 80)}...`);

    try {
      const html = await rateLimitedFetch(entry.detailUrl);
      const detail = parseDecisionDetail(html, entry.lang);

      if (FLAG_DRY_RUN) {
        log(`  [DRY-RUN] Would insert into '${table}': case=${entry.caseNumber}, date=${detail.date}, type=${entry.type}, sector=${detail.sector}, outcome=${detail.outcome}`);
        if (detail.pdfUrl) log(`  [DRY-RUN] PDF: ${detail.pdfUrl}`);
        inserted++;
      } else if (db) {
        if (table === "mergers") {
          insertMerger(db, entry, detail);
        } else {
          insertDecision(db, entry, detail);
        }
        inserted++;

        // Update resume progress
        if (FLAG_RESUME) {
          progress.completedUrls.push(entry.detailUrl);
          if (inserted % 10 === 0) saveProgress(progress);
        }
      }
    } catch (err) {
      error(`Failed to process ${entry.caseNumber}: ${err instanceof Error ? err.message : String(err)}`);
      errors++;
    }
  }

  // Phase 3: Update sector counts
  if (db && !FLAG_DRY_RUN) {
    log("\n--- Phase 3: Updating sector counts ---");
    updateSectorCounts(db);
  }

  // Save final resume state
  if (FLAG_RESUME) {
    progress.lastRun = new Date().toISOString();
    saveProgress(progress);
  }

  // Summary
  log("\n=== Ingestion Summary ===");
  log(`Entries found:    ${allEntries.size}`);
  log(`Inserted:         ${inserted}`);
  log(`Skipped (exists): ${skipped}`);
  log(`Errors:           ${errors}`);

  if (db) {
    const dCnt = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
    const mCnt = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
    const sCnt = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;
    log(`\nDatabase totals: ${sCnt} sectors, ${dCnt} decisions, ${mCnt} mergers`);
    db.close();
  }

  log(`Database: ${DB_PATH}`);
  log("Done.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

crawl().catch((err) => {
  error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
