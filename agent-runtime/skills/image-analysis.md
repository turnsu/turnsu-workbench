# Skill: Image Analysis

Purpose: analyze user-provided images through a configured Kimi vision provider.

Inputs:
- local attachment artifact path;
- sha256;
- user prompt;
- runtime context pointers.

Outputs:
- `analysis.json`;
- summary text;
- model route metadata.

Rules:
- API key comes from `KIMI_API_KEY`.
- Do not persist authorization headers or raw request bodies.
- Record attachment hash and policy decision.
