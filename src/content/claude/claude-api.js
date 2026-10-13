// claude.ai internal API access — same-origin fetches from the content
// script, so the user's session cookies ride along. Endpoints and response
// shapes: docs/claude-ai-recon.md §4. This is the primary completion/extract
// path; the DOM is only a fallback signal.

(() => {
  const PIC = (window.PIC ??= {});

  // claude.ai's deep-research tool. Its presence means a research job was
  // launched, and the report artifact is still on its way (see evaluate()).
  const RESEARCH_TOOL = 'launch_extended_search_task';

  let cachedOrgUuid = null;

  async function getJson(path) {
    const response = await fetch(path, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
    return response.json();
  }

  PIC.claudeApi = {
    async orgUuid() {
      if (cachedOrgUuid) return cachedOrgUuid;
      const orgs = await getJson('/api/organizations');
      // The account may also own an api-only (Console) org — we want chat.
      const chatOrg = orgs.find((o) => (o.capabilities ?? []).includes('chat')) ?? orgs[0];
      if (!chatOrg) throw new Error('No claude.ai organization found');
      cachedOrgUuid = chatOrg.uuid;
      return cachedOrgUuid;
    },

    async conversation(conversationUuid) {
      const org = await PIC.claudeApi.orgUuid();
      return getJson(
        `/api/organizations/${org}/chat_conversations/${conversationUuid}` +
          '?tree=True&rendering_mode=messages&render_all_tools=true',
      );
    },

    /**
     * Classify a conversation snapshot.
     * completed  -> research artifact present ({markdown, title})
     * ended_without_artifact -> the turn finished, no research task is in
     *   flight, and no artifact arrived; the orchestrator tolerates several
     *   of these in a row (an artifact can attach just after the turn ends)
     *   before declaring failure.
     * running    -> otherwise, INCLUDING a launched research task that has
     *   not produced its report yet.
     */
    evaluate(conversation) {
      const messages = conversation.chat_messages ?? [];
      const assistant = [...messages].reverse().find((m) => m.sender === 'assistant');
      if (!assistant) return { state: 'running' };

      let artifact = null;
      let researchLaunched = false;
      for (const message of messages) {
        if (message.sender !== 'assistant') continue;
        for (const block of message.content ?? []) {
          if (block.type === 'tool_use' && block.name === 'artifacts' && block.input?.content) {
            artifact = block.input; // last one wins (latest version)
          }
          if (block.name === RESEARCH_TOOL) researchLaunched = true;
        }
      }

      if (artifact) {
        return { state: 'completed', markdown: artifact.content, title: artifact.title };
      }

      // Deep research is ASYNC: launch_extended_search_task returns its
      // tool_result immediately (just a task_id) and the assistant turn ends
      // with stop_reason=end_turn while the research runs for many minutes.
      // The report artifact is appended to that same message when it lands.
      // So once a research task exists, stop_reason says nothing about the
      // report — keep polling until the artifact arrives or the run's own
      // research timeout fires. (Before this, a research taking longer than
      // MAX_ENDED_WITHOUT_ARTIFACT_POLLS minutes failed a healthy run.)
      if (researchLaunched) return { state: 'running' };

      if (assistant.stop_reason) {
        const trailingText = (assistant.content ?? [])
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('\n')
          .slice(-500);
        return {
          state: 'ended_without_artifact',
          reason: trailingText || `stop_reason=${assistant.stop_reason}`,
        };
      }
      return { state: 'running' };
    },
  };
})();
