// Lets a dispatcher paste the raw text of an old quote/proposal (whatever
// format it happens to be in -- a trip/labor/parts breakdown, a plain
// invoice, loose notes) into the AI Learning tab and have the AI pull out
// the bottom-line total instead of retyping it by hand. Deliberately a
// separate, tiny function from generate-proposal: no proposal_id, no DB
// reads/writes, just text in and a few extracted fields out.
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    if (!GEMINI_API_KEY) {
      return jsonResponse(
        { error: 'GEMINI_API_KEY is not configured for this project. Ask a Super Admin to set it as an Edge Function secret.' },
        500,
      )
    }
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401)
    }

    let body: { raw_text?: string }
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400)
    }
    const rawText = body.raw_text?.trim()
    if (!rawText) {
      return jsonResponse({ error: 'raw_text is required' }, 400)
    }

    const prompt = `
A dispatcher is importing an old repair quote into a tracking system. Below is the raw text of a past proposal/invoice breakdown -- the format varies job to job (it may list a trip fee, labor, parts & materials, a subtotal, and a grand total, or it may just be loose notes with a price mentioned somewhere).

"""
${rawText}
"""

Extract, as a JSON object:
- total_price: the single bottom-line dollar amount the client was actually quoted/billed for this job -- the final "Grand Total" / "Total" / "Price" figure, i.e. the last, all-inclusive number in the breakdown. Null if you genuinely can't find one.
- total_cost: ONLY set this if the text clearly separates a cost basis from a marked-up client price (e.g. it explicitly shows both "our cost" and "client price" as different figures). Most breakdowns like the one above show just one final total with no markup distinction -- in that common case, leave this null rather than guessing.
- markup_pct: ONLY set this if both total_price and a genuinely distinct total_cost are present and the markup is a clean, statable percentage. Otherwise null.
- trade: your best guess at the trade category for this job (e.g. Plumbing, Electrical, HVAC, General Maintenance, Flooring, Roofing) based on the work described. Null if you can't tell.
`.trim()

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 512,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                total_price: { type: 'NUMBER', nullable: true },
                total_cost: { type: 'NUMBER', nullable: true },
                markup_pct: { type: 'NUMBER', nullable: true },
                trade: { type: 'STRING', nullable: true },
              },
              required: ['total_price'],
            },
          },
        }),
      },
    )

    if (!res.ok) {
      if (res.status === 429) {
        return jsonResponse(
          { error: "Gemini's free-tier rate limit is maxed out right now. Wait about a minute before trying again." },
          429,
        )
      }
      const errText = await res.text()
      return jsonResponse({ error: `AI parsing failed (${res.status}): ${errText}` }, 502)
    }

    const geminiJson = await res.json()
    const candidate = geminiJson.candidates?.[0]
    const rawOut: string = (candidate?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? '')
      .join('')

    if (!rawOut) {
      return jsonResponse({ error: 'The AI did not return a result. Try again.' }, 502)
    }

    let parsed: { total_price: number | null; total_cost?: number | null; markup_pct?: number | null; trade?: string | null }
    try {
      parsed = JSON.parse(rawOut)
    } catch {
      return jsonResponse({ error: 'The AI returned malformed JSON. Try again.' }, 502)
    }

    return jsonResponse({ parsed })
  } catch (e) {
    return jsonResponse({ error: `Unexpected error: ${(e as Error).message}` }, 500)
  }
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}
