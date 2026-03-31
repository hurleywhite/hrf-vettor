# upload-applicants

Accepts a batch of applicants and inserts them into the pipeline.

- **Endpoint:** `POST /functions/v1/upload-applicants`
- **Auth:** Supabase service role key
- **Content-Type:** `application/json`

## Request body

```json
{
  "applicants": [
    {
      "name": "string",
      "email": "string",
      "organization": "string",
      "role": "string",
      ...
    }
  ]
}
```

## What it does

Inserts each applicant into the `applicants` table with status `queued`. This is the primary ingestion endpoint used to feed new applicants into the vetting pipeline. Supports arbitrary applicant fields beyond the required ones.
