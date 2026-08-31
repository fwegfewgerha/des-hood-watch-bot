// Simple in-memory store for in-progress embed drafts.
// Keyed by user ID — one draft at a time per user, which matches
// the "Draft ready. Choose an edit control to begin." flow.
//
// NOTE: this resets if the bot restarts. That's fine for a short
// editing session; it is not meant to store finished/sent embeds.

const drafts = new Map();

function emptyDraft() {
  return {
    channelId: null,
    color: '#5865F2',
    title: null,
    description: null,
    footerText: null,
    footerIcon: null,
    image: null,
    thumbnail: null,
    moveSourceUrl: null,
  };
}

function getDraft(userId) {
  if (!drafts.has(userId)) {
    drafts.set(userId, emptyDraft());
  }
  return drafts.get(userId);
}

function setDraft(userId, draft) {
  drafts.set(userId, draft);
}

function resetDraft(userId) {
  drafts.set(userId, emptyDraft());
  return drafts.get(userId);
}

function clearDraft(userId) {
  drafts.delete(userId);
}

module.exports = { getDraft, setDraft, resetDraft, clearDraft, emptyDraft };
