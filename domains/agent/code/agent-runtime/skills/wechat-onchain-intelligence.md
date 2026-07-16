---
name: wechat-onchain-intelligence
description: Combines normalized local WeChat, token, market, and on-chain evidence into a bounded intelligence summary. Use for local WeChat and Web3 research synthesis.
compatibility: Requires looloomi Agent Runtime bindings; trading, messaging, and external publishing remain blocked.
---

# Skill: WeChat On-chain Intelligence

Purpose: combine local normalized WeChat context, token entities, market snapshots, on-chain snapshots, crystals, proposals, memory, and handoffs.

Inputs:
- user prompt;
- selected skills/extensions;
- selected runtime context refs;
- optional image analysis artifacts.

Outputs:
- streaming assistant response;
- permissioned internal tool-call records;
- local artifact pointers;
- final markdown summary.

Forbidden:
- live WeChat reads;
- live `wechat-cli` commands;
- trading;
- sending messages;
- external publish.
