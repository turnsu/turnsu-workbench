// Only loaded editor content may be written. A newer selection invalidates older read responses.
export class LocalDraftNavigation {
  constructor(command) { this.command = command; this.version = 0; this.current = null; }
  edit(text, references) {
    if (!this.current?.loaded) return;
    this.current = { ...this.current, text, references };
  }
  adopt(projectId, sessionId, text, references) {
    this.current = { projectId, sessionId, text, references, loaded: true };
  }
  async save() {
    const value = this.current;
    if (value?.loaded) await this.command('draft.save', { projectId: value.projectId, sessionId: value.sessionId, text: value.text, references: value.references });
  }
  async select(projectId, sessionId, { start, loaded, locate }) {
    const version = ++this.version;
    try {
      await this.save();
      if (version !== this.version) return;
      const location = sessionId && locate ? await locate(sessionId) : { projectId };
      if (version !== this.version) return;
      // Navigation follows the collection; drafts and files keep their original owner.
      projectId = location.workingProjectId || location.projectId;
      this.current = { projectId, sessionId, loaded: false };
      start(location);
      const [draft, session] = await Promise.all([
        this.command('draft.read', { projectId, sessionId }),
        sessionId ? this.command('session.read', { sessionId }) : Promise.resolve(null),
      ]);
      if (version !== this.version) return;
      this.adopt(projectId, sessionId, draft.text, draft.references || []);
      loaded({ draft: this.current, session });
      return true;
    } catch (error) { if (version === this.version) throw error; }
  }
}
