---
name: image-analysis
description: Analyzes a user-provided image together with bounded runtime context. Use for screenshots, charts, and other image attachments that need structured observations.
compatibility: Requires the looloomi image-analysis binding and a configured vision provider for live analysis.
---

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
