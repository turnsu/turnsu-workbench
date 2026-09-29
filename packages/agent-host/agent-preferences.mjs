const supportedAgents = new Set(['codex', 'pi', 'claude', 'opencode']);

export class AgentPreferences {
  constructor(db) { this.db = db; }

  read(projectId, agents) {
    const project = projectId ? this.db.prepare('SELECT agent_id FROM agent_preferences WHERE scope=?').get(`project:${projectId}`)?.agent_id : null;
    const personal = this.db.prepare('SELECT agent_id FROM agent_preferences WHERE scope=?').get('personal')?.agent_id || null;
    const installed = agents.find(agent => agent.installed)?.id || null;
    const agentId = project || personal || installed || 'codex';
    return { agentId, source: project ? 'project' : personal ? 'personal' : installed ? 'installed' : 'fallback', project: project || null, personal };
  }

  save({ scope, projectId, agentId }) {
    if (scope !== 'project' && scope !== 'personal') throw new Error('Agent 偏好范围无效。');
    if (scope === 'project' && (!projectId || !this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))) throw new Error('找不到这个本地项目。');
    if (agentId !== null && !supportedAgents.has(agentId)) throw new Error('这个 Agent 的桌面接入尚未完成。');
    const key = scope === 'personal' ? 'personal' : `project:${projectId}`;
    if (agentId === null) this.db.prepare('DELETE FROM agent_preferences WHERE scope=?').run(key);
    else this.db.prepare('INSERT INTO agent_preferences(scope,agent_id) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET agent_id=excluded.agent_id').run(key, agentId);
  }
}
