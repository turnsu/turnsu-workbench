---
name: meeting-action-extractor
description: Extract explicit follow-up actions from meeting notes into a concise action list.
compatibility: Runs locally with no network, filesystem, connection, or external-action permission.
disable-model-invocation: true
---

# Meeting Action Extractor

Use this Skill when a meeting transcript or notes need a concise list of explicit follow-up actions.

Input:
- `transcript`: meeting notes or transcript text.

Creates:
- `actionItems`: explicit statements that describe a follow-up, commitment, to-do, or required next step;
- `summary`: the number of actions found.

Rules:
- process only the supplied text;
- do not access files, network services, accounts, or external tools;
- do not invent owners, deadlines, or actions that are not explicit in the input.
