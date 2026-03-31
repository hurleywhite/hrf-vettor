# dashboard

Serves the HRF OFF Vettor v2 HTML dashboard.

- **Endpoint:** `GET /functions/v1/dashboard`
- **Auth:** Supabase anon key via query param or Authorization header

## What it does

Renders a full HTML page showing:
- Summary stats (total applicants, approved/rejected/pending counts)
- Filterable table of all vetting results with verdict, risk score, and status
- Detail view for each applicant with research findings, GPT verdict rationale, and reviewer notes
- Links to trigger reprocessing or add manual notes

## Query params

| Param | Description |
|-------|-------------|
| `id`  | If provided, shows the detail page for that applicant |

The function queries the `vetting_results` and `applicants` tables directly and returns server-rendered HTML.
