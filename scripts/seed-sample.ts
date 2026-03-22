/**
 * Seed the CPC-CY (Commission for the Protection of Competition — Cyprus) database.
 * Usage: npx tsx scripts/seed-sample.ts [--force]
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CPCCY_DB_PATH"] ?? "data/cpc-cy.db";
const force = process.argv.includes("--force");
const dir = dirname(DB_PATH);
if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted ${DB_PATH}`); }
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

// --- Sectors ---
const sectors = [
  { id: "banking", name: "Banking", name_en: "Banking", description: "Commercial banks, cooperative credit institutions, and payment services in Cyprus.", decision_count: 2, merger_count: 1 },
  { id: "telecommunications", name: "Telecommunications", name_en: "Telecommunications", description: "Mobile communications, fixed broadband, cable television, and internet services.", decision_count: 2, merger_count: 1 },
  { id: "energy", name: "Energy", name_en: "Energy", description: "Electricity generation and distribution, petroleum products, and renewable energy.", decision_count: 1, merger_count: 0 },
  { id: "tourism", name: "Tourism", name_en: "Tourism", description: "Hotels, tour operators, airlines, and related tourism services.", decision_count: 1, merger_count: 1 },
  { id: "retail", name: "Retail", name_en: "Retail", description: "Supermarkets, food retail, and consumer goods distribution.", decision_count: 1, merger_count: 0 },
];
const insS = db.prepare("INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)");
for (const s of sectors) insS.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count);
console.log(`Inserted ${sectors.length} sectors`);

// --- Decisions ---
const decisions = [
  {
    case_number: "27/2023", title: "Bank of Cyprus / Hellenic Bank — Coordinated Mortgage Rates",
    date: "2023-06-15", type: "cartel", sector: "banking",
    parties: JSON.stringify(["Bank of Cyprus Public Company Ltd", "Hellenic Bank Public Company Ltd"]),
    summary: "CPC-CY investigated coordination between Cyprus's two largest banks on variable mortgage interest rates. The Commission found evidence of information exchange constituting a restriction of competition under Article 3 of Law 13(I)/2022.",
    full_text: "The Commission for the Protection of Competition investigated alleged coordination between Bank of Cyprus and Hellenic Bank regarding variable mortgage rate adjustments. The two banks collectively hold approximately 85% of the Cypriot mortgage market. The investigation found: (1) Regular bilateral meetings between senior bank officials at which interest rate strategies were discussed; (2) Systematic exchange of commercially sensitive information on planned rate adjustments prior to their public announcement; (3) Near-simultaneous rate changes by both banks in 14 out of 18 instances over a 24-month period. The Commission found a breach of Article 3(1) of Law 13(I)/2022 (equivalent to Article 101 TFEU). Fine imposed: EUR 3.2 million on Bank of Cyprus and EUR 1.8 million on Hellenic Bank. Both banks appealed to the Supreme Court of Cyprus.",
    outcome: "fine", fine_amount: 5_000_000, gwb_articles: JSON.stringify(["Law 13(I)/2022 Article 3(1)"]), status: "appealed",
  },
  {
    case_number: "18/2022", title: "Cablenet — Abuse of Dominance in Pay-TV Market",
    date: "2022-11-10", type: "abuse_of_dominance", sector: "telecommunications",
    parties: JSON.stringify(["Cablenet Communication Systems Ltd"]),
    summary: "CPC-CY investigated Cablenet's exclusivity practices in the pay-TV market. Cablenet held exclusive rights to key sports content preventing competitors from accessing premium content.",
    full_text: "The Commission investigated Cablenet Communication Systems Ltd, the dominant pay-TV operator in Cyprus, for exclusionary practices. Cablenet holds approximately 65% of the Cypriot pay-TV market. The investigation focused on: (1) Exclusive content agreements — Cablenet had exclusive multi-year deals for UEFA Champions League, Premier League, and Cyprus football league rights; (2) Long-term subscriber lock-in — 24-month minimum contract terms with high early termination fees; (3) Technical tying — Cablenet set-top boxes were incompatible with competitor services. The Commission found abuse of dominant position under Article 6 of Law 13(I)/2022. Cablenet was ordered to offer non-exclusive sublicensing of sports rights at FRAND terms, reduce minimum contract terms to 12 months, and ensure set-top box compatibility.",
    outcome: "prohibited", fine_amount: null, gwb_articles: JSON.stringify(["Law 13(I)/2022 Article 6"]), status: "final",
  },
  {
    case_number: "31/2023", title: "EAC — Electricity Authority of Cyprus Pricing Practices",
    date: "2023-09-20", type: "abuse_of_dominance", sector: "energy",
    parties: JSON.stringify(["Electricity Authority of Cyprus (EAC)"]),
    summary: "Sector inquiry into EAC's commercial electricity tariff structure and its impact on renewable energy development in Cyprus.",
    full_text: "The Commission conducted a sector inquiry into the electricity market following complaints from renewable energy developers. EAC is the dominant electricity supplier with approximately 90% market share. Findings: (1) Commercial tariffs — EAC's tariff structure for industrial customers disproportionately disadvantages new market entrants; (2) Grid connection fees — connection costs for distributed renewable generators were above EU comparable levels; (3) Net metering limitations — EAC's net metering rules limited self-consumption development. The Commission issued recommendations to the Cyprus Energy Regulatory Authority (CERA) for tariff structure reform and issued guidance to EAC on grid connection procedures. No fine was imposed as EAC agreed to implement recommended changes within 12 months.",
    outcome: "cleared_with_conditions", fine_amount: null, gwb_articles: JSON.stringify(["Law 13(I)/2022 Article 6", "Article 25"]), status: "final",
  },
  {
    case_number: "22/2022", title: "Hermes Airports — Access Conditions for Ground Handling",
    date: "2022-05-05", type: "abuse_of_dominance", sector: "tourism",
    parties: JSON.stringify(["Hermes Airports Ltd"]),
    summary: "CPC-CY investigated Hermes Airports' restrictions on independent ground handling service providers at Larnaca and Paphos airports.",
    full_text: "Hermes Airports Ltd operates Cyprus's two international airports under a 25-year concession. Ground handling services include passenger, baggage, cargo, fuelling, and aircraft maintenance services. The Commission investigated complaints from independent ground handlers that Hermes imposed unreasonable access restrictions: (1) Excessive fees — ground handling fees were 35% above comparable EU airports; (2) Limited space allocation — Hermes restricted check-in desk and apron access available to independent operators; (3) Information asymmetry — scheduling information was provided later to independent handlers than to Hermes's own handling subsidiary. The Commission found breach of Article 6(2)(a) (excessive pricing) and Article 6(2)(b) (limiting production). Hermes agreed to reduce fees, provide equal scheduling information access, and increase independent operator space allocation.",
    outcome: "cleared_with_conditions", fine_amount: null, gwb_articles: JSON.stringify(["Law 13(I)/2022 Article 6"]), status: "final",
  },
  {
    case_number: "15/2022", title: "Supermarket Price Coordination — Sector Inquiry Food Retail",
    date: "2022-03-15", type: "sector_inquiry", sector: "retail",
    parties: JSON.stringify(["Carrefour Cyprus", "Alphamega Hypermarkets", "Lidl Cyprus"]),
    summary: "CPC-CY sector inquiry into food retail pricing practices. The inquiry found information exchange through industry association but insufficient evidence of illegal coordination.",
    full_text: "The Commission conducted a sector inquiry into food retail pricing following consumer complaints about coordinated price increases for basic food products. The three largest supermarket chains account for approximately 70% of food retail in Cyprus. The inquiry examined: (1) Pricing data — analysis of pricing patterns for 200 basic food products over 3 years; (2) Information exchange — assessment of data shared through the Cyprus Association of Supermarkets; (3) Import parity pricing — examination of whether retail prices reflected import costs appropriately. Findings: significant information exchange occurs through industry associations but fell within permitted benchmarking; no direct evidence of price-fixing agreements; import margin analysis revealed some opportunities for consumer benefit. The Commission issued guidance on permissible information exchange and recommended the association revise its data sharing practices.",
    outcome: "cleared", fine_amount: null, gwb_articles: JSON.stringify(["Law 13(I)/2022 Article 3", "Article 25"]), status: "final",
  },
];

const insD = db.prepare("INSERT OR IGNORE INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insDAll = db.transaction(() => { for (const d of decisions) insD.run(d.case_number, d.title, d.date, d.type, d.sector, d.parties, d.summary, d.full_text, d.outcome, d.fine_amount, d.gwb_articles, d.status); });
insDAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Mergers ---
const mergers = [
  {
    case_number: "M-05/2022", title: "Hellenic Bank / AstroBank — Cypriot Bank Consolidation",
    date: "2022-08-30", sector: "banking", acquiring_party: "Hellenic Bank Public Company Ltd", target: "AstroBank Ltd",
    summary: "CPC-CY approved Hellenic Bank's acquisition of AstroBank with conditions requiring divestiture of commercial loan portfolio segments to preserve competition in SME banking.",
    full_text: "Hellenic Bank proposed to acquire AstroBank, a mid-tier Cypriot bank with approximately 8% market share in commercial banking. The transaction would increase Hellenic Bank's market share from 28% to approximately 36% in commercial banking. The Commission's assessment: (1) Retail banking — combined entity would have 40% share in retail deposits, approaching dominance; (2) SME lending — significant overlap in small business lending, combined share of 45% in certain loan categories; (3) Corporate banking — limited overlap as AstroBank focused on smaller corporates. Conditions: Hellenic Bank required to divest EUR 180 million of SME loan portfolio to a new entrant or existing competitor within 18 months of closing.",
    outcome: "cleared_with_conditions", turnover: 2_200_000_000,
  },
  {
    case_number: "M-02/2023", title: "Monaco Telecom / Cyta Hellas — Telecom Acquisition",
    date: "2023-03-15", sector: "telecommunications", acquiring_party: "Monaco Telecom", target: "Cyta Hellas (Greek subsidiary)",
    summary: "CPC-CY cleared Monaco Telecom's acquisition of Cyta Hellas in Phase 1, finding the transaction did not raise competition concerns as the parties operate in different geographic markets.",
    full_text: "Monaco Telecom proposed to acquire Cyta Hellas, the Greek telecommunications subsidiary of Cyprus Telecommunications Authority (CYTA). Cyta Hellas operates in Greece, while Monaco Telecom's primary operations are in Monaco and Africa. The Commission found: (1) No horizontal overlap — Monaco Telecom does not operate in Cyprus, and the Greek operations are outside Cypriot jurisdiction; (2) Vertical relationship — Monaco Telecom and CYTA have limited supplier relationships that do not raise foreclosure concerns; (3) Portfolio effects — the combined entity's Cyprus and Greek activities are geographically separate. The Commission cleared the merger in Phase 1 within 25 working days.",
    outcome: "cleared_phase1", turnover: 450_000_000,
  },
  {
    case_number: "M-08/2023", title: "Louis Hotels / Paphos Area Hotel Portfolio",
    date: "2023-11-01", sector: "tourism", acquiring_party: "Louis Hotels Ltd", target: "Paphos Portfolio (3 hotels)",
    summary: "CPC-CY cleared Louis Hotels' acquisition of three Paphos area hotels in Phase 1, finding no significant competitive concerns given the presence of multiple international hotel chains.",
    full_text: "Louis Hotels Ltd proposed to acquire three hotels in the Paphos area from a distressed local hotel group. Louis Hotels is one of Cyprus's largest hotel operators with approximately 15% of 4-5 star hotel capacity. The three target hotels add approximately 800 rooms to Louis's portfolio. The Commission's assessment found: (1) Geographic market — Paphos hotel market has numerous competitors including Marriott, Hilton, and local operators; (2) Market share — Louis Hotels combined share would reach 22% in Paphos 4-5 star hotels, below concern thresholds; (3) Tourism dynamics — hotel markets are highly contestable given tour operator switching. The merger was cleared in Phase 1.",
    outcome: "cleared_phase1", turnover: 180_000_000,
  },
];

const insM = db.prepare("INSERT OR IGNORE INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insMAll = db.transaction(() => { for (const m of mergers) insM.run(m.case_number, m.title, m.date, m.sector, m.acquiring_party, m.target, m.summary, m.full_text, m.outcome, m.turnover); });
insMAll();
console.log(`Inserted ${mergers.length} mergers`);

const dCnt = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const mCnt = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
const sCnt = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;
console.log(`\nSummary: ${sCnt} sectors, ${dCnt} decisions, ${mCnt} mergers`);
console.log(`Done. Database ready at ${DB_PATH}`);
db.close();
