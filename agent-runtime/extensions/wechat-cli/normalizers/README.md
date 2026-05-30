# WeChatCLI Normalizers

Normalization is implemented in `extension.ts` for the local MVP:

- export/session/message fields are mapped to normalized WeChat messages;
- symbols and contract-like strings are extracted for downstream token resolution;
- raw private content is not copied into user-facing UI beyond local artifact boundaries.
