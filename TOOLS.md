# Tools Reference

All tools use the prefix `cy_comp_` and return structured JSON with a `_meta` block containing disclaimer, data_age, copyright, and source_url fields.

## cy_comp_search_decisions

Full-text search across CPC-CY enforcement decisions.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query (e.g., `'abuse of dominance'`, `'price fixing'`) |
| `type` | string | no | Filter: `abuse_of_dominance`, `cartel`, `merger`, `sector_inquiry` |
| `sector` | string | no | Sector ID (e.g., `banking`, `telecommunications`) |
| `outcome` | string | no | Filter: `prohibited`, `cleared`, `cleared_with_conditions`, `fine` |
| `limit` | number | no | Max results (default 20, max 100) |

**Returns:** Array of decisions with case number, title, date, parties, outcome, fine amount, and summary.

---

## cy_comp_get_decision

Retrieve a single CPC-CY decision by case number.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `case_number` | string | yes | CPC-CY case number (e.g., `'27/2023'`, `'18/2022'`) |

**Returns:** Full decision record or error if not found.

---

## cy_comp_search_mergers

Search CPC-CY merger control decisions.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query (e.g., `'banking sector merger'`) |
| `sector` | string | no | Sector ID filter |
| `outcome` | string | no | Filter: `cleared`, `cleared_phase1`, `cleared_with_conditions`, `prohibited` |
| `limit` | number | no | Max results (default 20, max 100) |

**Returns:** Array of merger cases with acquiring party, target, sector, and outcome.

---

## cy_comp_get_merger

Retrieve a single merger control decision by case number.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `case_number` | string | yes | CPC-CY merger case number (e.g., `'M-12/2023'`) |

**Returns:** Full merger record or error if not found.

---

## cy_comp_list_sectors

List all sectors with CPC-CY enforcement activity.

**Parameters:** None

**Returns:** Array of sectors with decision counts and merger counts.

---

## cy_comp_about

Return server metadata: version, data source, coverage summary, and tool list.

**Parameters:** None

**Returns:** Server metadata object.

---

## cy_comp_list_sources

List all data sources with provenance metadata.

**Parameters:** None

**Returns:** Array of source objects with name, URL, scope, jurisdiction, language, license, and limitations.

---

## cy_comp_check_data_freshness

Check data freshness and staleness for each source.

**Parameters:** None

**Returns:** Freshness status per source with staleness warnings and refresh recommendations.
