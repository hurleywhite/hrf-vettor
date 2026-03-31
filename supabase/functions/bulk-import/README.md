# bulk-import

Original simple bulk import endpoint (superseded by upload-applicants).

- **Endpoint:** `POST /functions/v1/bulk-import`
- **Auth:** Supabase service role key
- **Content-Type:** `application/json`

## Request body

```json
[
  { "name": "string", "email": "string", ... },
  { "name": "string", "email": "string", ... }
]
```

## What it does

Accepts a JSON array of applicant objects and inserts them into the `applicants` table. This was the initial import endpoint. The `upload-applicants` function is the newer version with additional validation and a wrapper object format.
