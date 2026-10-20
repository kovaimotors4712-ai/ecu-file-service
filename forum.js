'use strict';
(() => {
  const api = window.EfsiSupabase;
  const $ = (selector, root) => (root || document).querySelector(selector);
  const state = { user: null, profile: null, categories: [], topics: [], openTopics: new Set(), authMode: 'signin' };
  const statusEl = $('#forum-status');
  const topicList = $('#forum-topics');
  const topicMessage = $('#forum-topic-message');
  const authMessage = $('#forum-auth-message');

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }
  function setStatus(message) { statusEl.textContent = message || ''; }
  function setMessage(element, message) { element.textContent = message || ''; }
  function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
  function isAdmin() { return Boolean(state.user && state.user.app_metadata && state.user.app_metadata.role === 'admin'); }
  function canPost() { return Boolean(state.user && state.profile); }
  function userId() { return state.user && state.user.id ? state.user.id : null; }
  function updateControls() {
    $('#forum-auth-controls').hidden = Boolean(state.user);
    $('#forum-profile-setup').hidden = !state.user || Boolean(state.profile);
    $('#forum-signed-in').hidden = !state.user || !state.profile;
    $('#forum-account-note').textContent = state.profile ? 'Your forum profile is ready.' : state.user ? 'Finish your public forum profile to participate.' : 'Sign in to post questions, reply and report inappropriate content.';
    $('#forum-user-name').textContent = state.profile ? state.profile.display_name : (state.user ? state.user.email : '');
    $('#forum-topic-submit').disabled = !canPost();
    if (isAdmin()) $('#forum-moderation').hidden = false;
  }
  async function refreshAuth() {
    state.user = null;
    state.profile = null;
    const session = api && api.getSession ? api.getSession() : null;
    if (session && session.access_token) {
      try { state.user = await api.auth.getUser(); } catch { state.user = null; }
    }
    if (state.user && state.user.id) {
      try {
        const rows = await api.rest('forum_profiles?select=id,username,display_name,bio&id=eq.' + encodeURIComponent(state.user.id) + '&limit=1');
        state.profile = Array.isArray(rows) && rows.length ? rows[0] : null;
      } catch { state.profile = null; }
    }
    updateControls();
    if (isAdmin()) await loadReports();
  }
  async function loadCategories() {
    const rows = await api.rest('forum_categories?select=id,slug,title,description,sort_order,is_locked&is_active=eq.true&order=sort_order.asc');
    state.categories = Array.isArray(rows) ? rows : [];
    const filter = $('#forum-category');
    const formSelect = $('#forum-new-category');
    filter.replaceChildren(node('option', '', 'All categories'));
    formSelect.replaceChildren(node('option', '', 'Choose a category'));
    state.categories.forEach((category) => {
      const item = node('option', '', category.title); item.value = category.id; filter.appendChild(item);
      if (!category.is_locked) { const option = node('option', '', category.title); option.value = category.id; formSelect.appendChild(option); }
    });
  }
  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function topicAuthor(topic) { return topic.author && (topic.author.display_name || topic.author.username) ? (topic.author.display_name || topic.author.username) : 'Community member'; }
  function topicCategory(topic) {
    if (topic.category && topic.category.title) return topic.category.title;
    const category = state.categories.find((item) => item.id === topic.category_id);
    return category ? category.title : 'Automotive';
  }
  async function loadTopics() {
    topicList.replaceChildren(node('p', 'forum-empty', 'Loading topics…'));
    try {
      const params = ['select=id,category_id,author_id,title,body,status,is_pinned,created_at,updated_at,author:forum_profiles!forum_topics_author_id_fkey(username,display_name),category:forum_categories!forum_topics_category_id_fkey(title)', 'status=in.(published,locked)'];
      const category = $('#forum-category').value;
      const search = $('#forum-search').value.trim().replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 80);
      if (category) params.push('category_id=eq.' + encodeURIComponent(category));
      if (search) params.push('or=(title.ilike.*' + encodeURIComponent(search) + '*,body.ilike.*' + encodeURIComponent(search) + '*)');
      params.push('order=is_pinned.desc,' + ($('#forum-sort').value === 'created_at' ? 'created_at' : 'updated_at') + '.desc');
      params.push('limit=40');
      const rows = await api.rest('forum_topics?' + params.join('&'));
      state.topics = Array.isArray(rows) ? rows : [];
      renderTopics();
      setStatus(state.topics.length ? state.topics.length + ' topic(s) loaded.' : 'No topics found. Start a useful discussion once your account profile is ready.');
    } catch (error) {
      topicList.replaceChildren(node('p', 'forum-empty', 'Forum data is not available yet. The database migration and access policies must be installed and verified before posting is enabled.'));
      setStatus('The forum database is not ready or could not be reached.');
    }
  }
  function renderTopics() {
    topicList.replaceChildren();
    if (!state.topics.length) { topicList.appendChild(node('p', 'forum-empty', 'No discussions yet for this search. Be the first to start a useful topic.')); return; }
    state.topics.forEach((topic) => {
      const card = node('article', 'forum-topic'); card.dataset.topicId = topic.id;
      const head = node('div', 'forum-topic-head');
      const titleWrap = node('div');
      titleWrap.appendChild(node('h3', '', topic.title));
      titleWrap.appendChild(node('div', 'forum-topic-meta', topicCategory(topic) + ' · ' + topicAuthor(topic) + ' · ' + formatDate(topic.created_at)));
      head.appendChild(titleWrap);
      head.appendChild(node('span', 'forum-topic-status', topic.is_pinned ? 'PINNED' : String(topic.status || 'published').toUpperCase()));
      card.appendChild(head);
      card.appendChild(node('p', '', topic.body));
      const actions = node('div', 'forum-topic-actions');
      const replies = node('button', '', state.openTopics.has(topic.id) ? 'Hide replies' : 'View replies'); replies.type = 'button'; replies.dataset.action = 'replies'; replies.dataset.topicId = topic.id; actions.appendChild(replies);
      if (canPost()) { const report = node('button', '', 'Report'); report.type = 'button'; report.dataset.action = 'report'; report.dataset.topicId = topic.id; actions.appendChild(report); }
      if (isAdmin()) {
        const moderate = node('button', '', topic.status === 'locked' ? 'Publish topic' : 'Lock topic');
        moderate.type = 'button'; moderate.dataset.action = 'lock'; moderate.dataset.topicId = topic.id; actions.appendChild(moderate);
        const hide = node('button', '', 'Hide topic'); hide.type = 'button'; hide.dataset.action = 'hide'; hide.dataset.topicId = topic.id; actions.appendChild(hide);
      }
      card.appendChild(actions);
      const repliesBox = node('div', 'forum-replies'); repliesBox.hidden = !state.openTopics.has(topic.id); repliesBox.dataset.repliesFor = topic.id; card.appendChild(repliesBox);
      if (!repliesBox.hidden) loadReplies(topic.id, repliesBox, topic.status);
      topicList.appendChild(card);
    });
  }
  async function loadReplies(topicId, container, topicStatus) {
    container.replaceChildren(node('p', 'forum-topic-meta', 'Loading replies…'));
    try {
      const posts = await api.rest('forum_posts?select=id,topic_id,author_id,body,status,created_at,author:forum_profiles!forum_posts_author_id_fkey(username,display_name)&topic_id=eq.' + encodeURIComponent(topicId) + '&status=eq.published&order=created_at.asc&limit=250');
      container.replaceChildren();
      if (!Array.isArray(posts) || !posts.length) container.appendChild(node('p', 'forum-topic-meta', 'No replies yet.'));
      (posts || []).forEach((post) => {
        const reply = node('article', 'forum-reply');
        reply.appendChild(node('div', 'forum-topic-meta', (post.author && (post.author.display_name || post.author.username) || 'Community member') + ' · ' + formatDate(post.created_at)));
        reply.appendChild(node('p', '', post.body)); container.appendChild(reply);
      });
      if (canPost() && topicStatus === 'published') {
        const form = node('form', 'forum-reply-form');
        const label = node('label', '', 'Your reply'); const textarea = node('textarea'); textarea.name = 'body'; textarea.minLength = 2; textarea.maxLength = 10000; textarea.rows = 3; textarea.required = true; textarea.placeholder = 'Describe the evidence, checks or repair result…'; label.appendChild(textarea);
        const submit = node('button', 'button button-dark', 'Post reply'); submit.type = 'submit';
        form.appendChild(label); form.appendChild(submit);
        form.addEventListener('submit', async (event) => {
          event.preventDefault(); submit.disabled = true;
          try {
            await api.rest('forum_posts', { method: 'POST', body: { topic_id: topicId, author_id: userId(), body: textarea.value.trim() }, prefer: 'return=minimal' });
            await loadReplies(topicId, container, topicStatus); setStatus('Reply posted.');
          } catch (error) { container.appendChild(node('p', 'forum-message', error.message || 'Reply could not be posted.')); submit.disabled = false; }
        });
        container.appendChild(form);
      } else if (!canPost()) container.appendChild(node('p', 'forum-topic-meta', 'Sign in and create a forum profile to reply.'));
      else container.appendChild(node('p', 'forum-topic-meta', 'This topic is locked; replies are closed.'));
    } catch (error) {
      container.replaceChildren(node('p', 'forum-empty', 'Replies could not be loaded. Check forum database setup.'));
    }
  }
  async function reportTopic(topicId) {
    const details = window.prompt('Briefly explain why this topic should be reviewed. Do not include private customer data.');
    if (!details) return;
    if (details.trim().length < 10 || details.length > 1000) { setStatus('Report details must be 10–1000 characters.'); return; }
    try {
      await api.rest('forum_reports', { method: 'POST', body: { reporter_id: userId(), target_type: 'topic', target_id: topicId, reason: 'other', details: details.trim() }, prefer: 'return=minimal' });
      setStatus('Report submitted privately for moderator review.');
    } catch (error) { setStatus(error.message || 'The report could not be submitted.'); }
  }
  async function moderateTopic(topicId, action) {
    const topic = state.topics.find((item) => item.id === topicId);
    if (!topic || !isAdmin()) return;
    const status = action === 'hide' ? 'hidden' : topic.status === 'locked' ? 'published' : 'locked';
    try {
      await api.rest('forum_topics?id=eq.' + encodeURIComponent(topicId), { method: 'PATCH', body: { status: status }, prefer: 'return=minimal' });
      setStatus('Topic moderation action saved.'); await loadTopics();
    } catch (error) { setStatus(error.message || 'Moderation action failed.'); }
  }
  async function loadReports() {
    if (!isAdmin()) return;
    const box = $('#forum-reports'); box.replaceChildren(node('p', 'forum-topic-meta', 'Loading open reports…'));
    try {
      const rows = await api.rest('forum_reports?select=id,target_type,target_id,reason,details,created_at&status=eq.open&order=created_at.asc&limit=50');
      box.replaceChildren();
      if (!rows.length) box.appendChild(node('p', 'forum-topic-meta', 'No open reports.'));
      rows.forEach((report) => {
        const row = node('div', 'forum-report-row');
        row.appendChild(node('strong', '', report.reason.toUpperCase() + ' · ' + report.target_type));
        row.appendChild(node('p', '', report.details));
        row.appendChild(node('div', 'forum-topic-meta', 'Report received ' + formatDate(report.created_at)));
        const button = node('button', 'forum-text-button', 'Mark resolved'); button.type = 'button';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await api.rest('forum_reports?id=eq.' + encodeURIComponent(report.id), { method: 'PATCH', body: { status: 'resolved', reviewed_by: userId(), reviewed_at: new Date().toISOString() }, prefer: 'return=minimal' }); await loadReports(); }
          catch (error) { button.disabled = false; setStatus(error.message || 'Could not update the report.'); }
        });
        row.appendChild(button); box.appendChild(row);
      });
    } catch { box.replaceChildren(node('p', 'forum-topic-meta', 'Report review is limited to moderators.')); }
  }
  function setAuthMode(mode) {
    state.authMode = mode;
    document.querySelectorAll('[data-auth-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.authMode === mode)));
    $('#forum-auth-submit').textContent = mode === 'signup' ? 'Create account →' : 'Sign in securely →';
    $('#forum-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  }
  async function start() {
    $('#forum-year').textContent = String(new Date().getFullYear());
    if (!api || !api.rest || !api.auth) {
      setStatus('Account service could not be initialized. Please try again later.'); return;
    }
    try {
      await loadCategories();
      await refreshAuth();
      await loadTopics();
    } catch (error) {
      setStatus('The forum is staged but database setup is required before it can operate.');
    }
  }
  document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  $('#forum-auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#forum-auth-submit'); button.disabled = true; setMessage(authMessage, 'Connecting securely…');
    const values = formData(event.currentTarget);
    try {
      if (state.authMode === 'signup') {
        const result = await api.signUp(values.email.trim(), values.password);
        if (!result.access_token) setMessage(authMessage, 'Account request received. Confirm your email, then sign in to create a forum profile.');
        else { setMessage(authMessage, 'Account created. Finish your public forum profile.'); await refreshAuth(); }
      } else {
        await api.signIn(values.email.trim(), values.password); setMessage(authMessage, 'Signed in.'); await refreshAuth();
      }
      await loadTopics();
    } catch (error) { setMessage(authMessage, error.message || 'Account request failed.'); }
    finally { button.disabled = false; }
  });
  $('#forum-profile-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!userId()) return; const form = event.currentTarget; const values = formData(form); const button = form.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      await api.rest('forum_profiles', { method: 'POST', body: { id: userId(), username: values.username.trim(), display_name: values.display_name.trim(), bio: values.bio.trim() }, prefer: 'return=minimal' });
      await refreshAuth(); await loadTopics(); setMessage(authMessage, 'Forum profile saved.');
    } catch (error) { setMessage(authMessage, error.message || 'Profile could not be saved. The username may already be taken.'); }
    finally { button.disabled = false; }
  });
  $('#forum-sign-out').addEventListener('click', async () => {
    try { await api.signOut(); } catch {}
    state.user = null; state.profile = null; updateControls(); setMessage(authMessage, 'Signed out.'); renderTopics();
  });
  $('#forum-topic-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canPost()) { setMessage(topicMessage, 'Sign in and save a forum profile before publishing.'); return; }
    const form = event.currentTarget; const values = formData(form); const button = $('#forum-topic-submit'); button.disabled = true; setMessage(topicMessage, 'Publishing topic…');
    try {
      await api.rest('forum_topics', { method: 'POST', body: { category_id: values.category_id, author_id: userId(), title: values.title.trim(), body: values.body.trim() }, prefer: 'return=minimal' });
      form.reset(); setMessage(topicMessage, 'Topic published.'); await loadTopics();
    } catch (error) { setMessage(topicMessage, error.message || 'Topic could not be published. Please check category access and try again.'); }
    finally { button.disabled = !canPost(); }
  });
  $('#forum-topics').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const id = button.dataset.topicId;
    if (button.dataset.action === 'replies') {
      if (state.openTopics.has(id)) state.openTopics.delete(id); else state.openTopics.add(id);
      renderTopics();
    } else if (button.dataset.action === 'report') await reportTopic(id);
    else if (button.dataset.action === 'lock' || button.dataset.action === 'hide') await moderateTopic(id, button.dataset.action);
  });
  $('#forum-search-form').addEventListener('submit', (event) => { event.preventDefault(); loadTopics(); });
  $('#forum-category').addEventListener('change', loadTopics);
  $('#forum-sort').addEventListener('change', loadTopics);
  $('#forum-refresh').addEventListener('click', async () => { await refreshAuth(); await loadTopics(); });
  start();
})();
