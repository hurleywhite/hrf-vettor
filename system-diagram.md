# HRF OFF Vettor v2 — System Architecture

```mermaid
flowchart TD
    subgraph INPUT["INPUT LAYER"]
        A[("Applicant Data\n(Spreadsheet / Airtable)")] --> B["Import to Supabase\n(applicants table)"]
    end

    subgraph PIPELINE["AI VETTING PIPELINE (Python)"]
        B --> C{"WhiteList\nCheck"}
        C -->|"Match found\n(prior attendee)"| AUTO_APPROVE["Auto-Approve\n✅ Skip all stages"]
        C -->|"No match"| S1

        subgraph STAGE1["STAGE 1: Spam Triage"]
            S1["gpt-4o-mini\n(fast, cheap)"]
            S1 -->|"SPAM ≥ 85%\nconfidence"| SPAM["Mark as Spam\n🗑️ Skip remaining"]
            S1 -->|"NOT SPAM"| S2A
        end

        subgraph STAGE2["STAGE 2: Research + Reasoning"]
            subgraph SCRAPE["2a: Apify Web Scraping (parallel)"]
                S2A["Launch Scrapers"] --> G["Google Search\nScraper"]
                S2A --> L["LinkedIn\n(via Google)"]
                S2A --> T["Twitter/X\n(via Google)"]
                S2A --> I["Instagram\n(via Google)"]
                S2A --> W["Website Content\nCrawler"]
                G & L & T & I & W --> DOSSIER["Assembled Dossier\n(structured JSON)"]
            end

            DOSSIER --> S2B["2b: GPT-5 Reasoning\nover Dossier"]
            S2B --> S2OUT{"Verdict +\nConfidence?"}
        end

        S2OUT -->|"APPROVED ≥ 70%\nconfidence"| APPROVED["✅ Approved"]
        S2OUT -->|"REJECTED ≥ 70%\nconfidence"| REJECTED["❌ Rejected"]
        S2OUT -->|"FLAGGED or\nconfidence < 70%"| S3

        subgraph STAGE3["STAGE 3: Deep Review (≈10-15% of applicants)"]
            S3["GPT-5\nDeep Analysis"]
            S3 --> S3OUT{"Resolved?"}
        end

        S3OUT -->|"Resolved ≥ 80%"| RESOLVED["✅ or ❌\nResolved"]
        S3OUT -->|"Still ambiguous"| HUMAN["🟡 Flagged for\nHuman Review"]
    end

    subgraph OUTPUT["OUTPUT LAYER"]
        AUTO_APPROVE & SPAM & APPROVED & REJECTED & RESOLVED & HUMAN --> DB[("Supabase\nvetting_results")]
        DB --> DASH["Web Dashboard\n(view all results)"]
        DB -.->|"Phase B"| AT["Airtable\n(team workspace)"]
        DB -.->|"Phase B"| SLACK["Slack Notifications\n(flagged cases)"]
    end

    style INPUT fill:#e8f4f8,stroke:#2196F3
    style STAGE1 fill:#fff3e0,stroke:#FF9800
    style SCRAPE fill:#e8f5e9,stroke:#4CAF50
    style STAGE3 fill:#fce4ec,stroke:#E91E63
    style OUTPUT fill:#f3e5f5,stroke:#9C27B0
    style SPAM fill:#ffcdd2,stroke:#f44336
    style APPROVED fill:#c8e6c9,stroke:#4CAF50
    style REJECTED fill:#ffcdd2,stroke:#f44336
    style HUMAN fill:#fff9c4,stroke:#FFC107
```

## Data Flow Summary

| Stage | Model | Purpose | Cost/Applicant | ~% Processed |
|-------|-------|---------|----------------|-------------|
| WhiteList | None | Auto-approve prior attendees | $0 | ~25% |
| Stage 1 | gpt-4o-mini | Spam triage | ~$0.005 | 100% |
| Stage 2a | Apify actors | Web scraping (Google, social, org sites) | ~$0.03 | ~90% |
| Stage 2b | GPT-5 | Reasoning over dossier → verdict | ~$0.10 | ~90% |
| Stage 3 | GPT-5 | Deep review of ambiguous cases | ~$0.10 | ~10-15% |

## Per-Applicant Output
- **Verdict:** Approved / Flagged / Rejected / Spam
- **Confidence:** 0-100%
- **Scorecard:** What was confirmed / not found / concerning
- **Recommended next step:** Specific action for human reviewer
- **Full dossier:** All scraped data, URLs, Google results
- **Audit trail:** Which models ran, latency, cost
