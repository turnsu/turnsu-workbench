import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkspaceInvitationMessage } from "../../src/auth/smtp-tls-invitation-mailer.mjs";

test("SMTP invitation rendering keeps the raw invitation token in the fragment and rejects non-HTTPS links", () => {
  const message = renderWorkspaceInvitationMessage({
    recipientEmail: "member@example.test",
    workspaceName: "Team\r\nInjected header",
    invitationUrl: "https://app.example.test/invite#token=v1~invitation~invite-1~signature",
    expiresAt: "2026-08-12T00:00:00.000Z",
    from: "noreply@example.test",
    messageId: "message-1",
  });
  assert.match(message, /Subject: Workspace invitation/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  const text = Buffer.from(message.split("\r\n\r\n")[1], "base64").toString("utf8");
  assert.match(text, /https:\/\/app\.example\.test\/invite#token=v1~invitation~invite-1~signature/);
  assert.doesNotMatch(message, /\r\nInjected header:/);
  assert.throws(
    () => renderWorkspaceInvitationMessage({
      recipientEmail: "member@example.test",
      workspaceName: "Team",
      invitationUrl: "http://app.example.test/invite#token=raw",
      expiresAt: "2026-08-12T00:00:00.000Z",
      from: "noreply@example.test",
    }),
    { code: "smtp_invitation_url_invalid" },
  );
});
