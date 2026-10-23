(function () {
  'use strict';

  const api = window.EfsiSupabase;
  const $ = function (selector) { return document.querySelector(selector); };
  const topicList = $('#forum-topic-list');
  const topicsMessage = $('#forum-topics-message');
  const categoryFilter = $('#forum-category-filter');
  const searchInput = $('#forum-search');
  const statusFilter = $('#forum-status-filter');
  let user = api && api.getSession() ? api.getSession().user : null;
  let categories = [];
  let topics = [];
  let profile = null;
  let activeTopic = null;

  function setMessage(element, message, type) {
    if (!element) return;
    element.textContent = message || '';
    element.className = 'status-message' + (type ? ' ' + type : '');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
    });
  }

  function validUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  function friendlyReadError(element) {
    setMessage(element, 'Community data could not be loaded. The forum database may still need setup, or the connection may be temporarily unavailable.', 'error');
  }

  function displayNameFor(id, profiles) {
    return profiles[id] && profiles[id].display_name ? profiles[id].display_name : 'Community member';
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
  }

  async function profilesFor(ids) {
    const safeIds = Array.from(new Set(ids.filter(validUuid)));
    if (!safeIds.length) return {};
    const rows = await api.rest('forum_profiles?select=user_id,display_name,bio&user_id=in.(' + safeIds.join(',') + ')');
    const map = {};
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (validUuid(row.user_id)) map[row.user_id] = row;
    });
    return map;
  }

  function fillCategorySelect(select, includeAll) {
    if (!select) return;
    const first = includeAll ? "<option value=''>All categories</option>" : "<option value=''>Select a category</option>";
    select.innerHTML = first + categories.map(function (category) {
      return "<option value='" + escapeHtml(category.id) + "'>" + escapeHtml(category.title) + "</option>";
    }).join('');
  }

  async function loadCategories() {
    const rows = await api.rest('forum_categories?select=id,slug,title,description,sort_order&is_active=eq.true&order=sort_order.asc');
    categories = Array.isArray(rows) ? rows : [];
    fillCategorySelect(categoryFilter, true);
    fillCategorySelect($('#forum-new-topic-category'), false);
  }

  function renderTopics() {
    const query = String(searchInput.value || '').trim().toLocaleLowerCase();
    const categoryId = categoryFilter.value;
    const visible = topics.filter(function (topic) {
      if (categoryId && topic.category_id !== categoryId) return false;
      if (statusFilter && statusFilter.value === 'unanswered' && Number(topic.reply_count || 0) > 0) return false;
      if (statusFilter && statusFilter.value === 'solved' && !topic.accepted_reply_id) return false;
      if (statusFilter && statusFilter.value === 'unsolved' && topic.accepted_reply_id) return false;
      if (!query) return true;
      return (topic.title + ' ' + topic.body + ' ' + (categories.find(function (item) { return item.id === topic.category_id; }) || {}).title)
        .toLocaleLowerCase().includes(query);
    });

    if (!visible.length) {
      topicList.innerHTML = "<div class='empty-state'>No matching topics yet. Try another search or start a useful discussion.</div>";
      return;
    }

    const profiles = topicList._profiles || {};
    topicList.innerHTML = visible.map(function (topic) {
      const category = categories.find(function (item) { return item.id === topic.category_id; });
      const preview = topic.body.length > 280 ? topic.body.slice(0, 280) + '…' : topic.body;
      return "<article class='topic-card'>" +
        "<div class='topic-card-top'><span class='topic-tag'>" + escapeHtml(category ? category.title : 'Discussion') + "</span>" +
        (topic.is_pinned ? "<span class='topic-pin'>PINNED</span>" : '') +
        (topic.is_locked ? "<span class='topic-locked'>LOCKED</span>" : '') +
        (topic.accepted_reply_id ? "<span class='topic-tag'>SOLVED</span>" : '') +
        (Number(topic.reply_count || 0) === 0 ? "<span class='topic-tag'>UNANSWERED</span>" : "<span class='topic-tag'>" + Number(topic.reply_count || 0) + (Number(topic.reply_count || 0) === 1 ? ' REPLY' : ' REPLIES') + "</span>") + "</div>" +
        "<h3><button type='button' class='topic-open' data-topic-id='" + escapeHtml(topic.id) + "'>" + escapeHtml(topic.title) + "</button></h3>" +
        "<p class='topic-preview'>" + escapeHtml(preview) + "</p>" +
        "<div class='topic-meta'><span>By <strong>" + escapeHtml(displayNameFor(topic.author_id, profiles)) + "</strong></span><span>" + escapeHtml(formatDate(topic.created_at)) + "</span></div>" +
        "</article>";
    }).join('');
  }

  async function loadTopics() {
    if (!api) {
      setMessage(topicsMessage, 'Account service is unavailable. Please try again later.', 'error');
      return;
    }
    setMessage(topicsMessage, 'Loading topics…');
    try {
      const rows = await api.rest('forum_topics?select=id,category_id,author_id,title,body,is_pinned,is_locked,accepted_reply_id,created_at&order=is_pinned.desc,created_at.desc&limit=100');
      topics = Array.isArray(rows) ? rows : [];
      topics.forEach(function (topic) { topic.reply_count = 0; });
      const topicIds = topics.filter(function (topic) { return validUuid(topic.id); }).map(function (topic) { return topic.id; });
      if (topicIds.length) {
        try {
          const replyRows = await api.rest('forum_replies?select=topic_id&topic_id=in.(' + topicIds.join(',') + ')&is_hidden=eq.false&limit=5000');
          (Array.isArray(replyRows) ? replyRows : []).forEach(function (reply) {
            const topic = topics.find(function (item) { return item.id === reply.topic_id; });
            if (topic) topic.reply_count += 1;
          });
        } catch (_) { /* Topic browsing remains available if reply counts cannot be loaded. */ }
      }
      topicList._profiles = await profilesFor(topics.map(function (topic) { return topic.author_id; }));
      setMessage(topicsMessage, '');
      renderTopics();
    } catch (_) {
      topics = [];
      topicList.innerHTML = '';
      friendlyReadError(topicsMessage);
    }
  }

  async function loadProfile() {
    profile = null;
    if (!user || !validUuid(user.id)) return;
    const rows = await api.rest('forum_profiles?select=user_id,display_name,bio&user_id=eq.' + encodeURIComponent(user.id) + '&limit=1');
    profile = Array.isArray(rows) && rows.length ? rows[0] : null;
    $('#forum-display-name').value = profile ? profile.display_name : '';
    $('#forum-bio').value = profile ? profile.bio || '' : '';
    setMessage($('#forum-profile-message'), profile ? 'Your public profile is saved.' : 'Choose a display name and save your profile before creating a topic or reply.');
  }

  async function loadModerationQueue() {
    const panel = $('#forum-moderation-panel');
    const list = $('#forum-moderation-list');
    const message = $('#forum-moderation-message');
    if (!panel || !user || !['admin', 'moderator'].includes(String(user.app_metadata && user.app_metadata.role || '').toLowerCase())) return;
    setMessage(message, 'Loading open reports…');
    try {
      const reports = await api.rest('forum_reports?select=id,reporter_id,topic_id,reply_id,reason,status,created_at&status=eq.open&order=created_at.asc&limit=50');
      const rows = Array.isArray(reports) ? reports : [];
      const targets = await Promise.all(rows.map(async function (report) {
        try {
          if (report.topic_id) {
            const found = await api.rest('forum_topics?select=id,title,is_hidden,is_locked&id=eq.' + encodeURIComponent(report.topic_id) + '&limit=1');
            return { report: report, target: Array.isArray(found) ? found[0] : null, kind: 'topic' };
          }
          const found = await api.rest('forum_replies?select=id,body,is_hidden,topic_id&id=eq.' + encodeURIComponent(report.reply_id) + '&limit=1');
          return { report: report, target: Array.isArray(found) ? found[0] : null, kind: 'reply' };
        } catch (_) { return { report: report, target: null, kind: report.topic_id ? 'topic' : 'reply' }; }
      }));
      if (!targets.length) {
        list.innerHTML = "<div class='empty-state'>No open reports. The moderation queue is clear.</div>";
        setMessage(message, '');
        return;
      }
      list.innerHTML = targets.map(function (entry) {
        const report = entry.report;
        const target = entry.target;
        const targetText = target ? (entry.kind === 'topic' ? target.title : target.body) : 'Target content is unavailable or was removed.';
        const status = target && target.is_hidden ? ' · Already hidden' : '';
        const topicActions = entry.kind === 'topic' && target ? "<button type='button' class='button button-outline' data-mod-action='lock-topic' data-target-id='" + escapeHtml(target.id) + "'>" + (target.is_locked ? 'Unlock topic' : 'Lock topic') + "</button>" : '';
        const hideAction = target && !target.is_hidden ? "<button type='button' class='button button-outline' data-mod-action='hide-" + entry.kind + "' data-target-id='" + escapeHtml(target.id) + "'>Hide " + entry.kind + "</button>" : '';
        const resolveAction = "<button type='button' class='button button-lime' data-mod-action='resolve-report' data-report-id='" + escapeHtml(report.id) + "'>Resolve report</button>";
        return "<article class='topic-card'><div class='topic-card-top'><span class='topic-tag'>" + (entry.kind === 'topic' ? 'Reported topic' : 'Reported reply') + "</span><span class='state-pill'>" + escapeHtml(report.status) + "</span></div>" +
          "<h3>" + escapeHtml(targetText.slice(0, 220)) + "</h3><p class='topic-preview'>" + escapeHtml(report.reason) + "</p>" +
          "<div class='topic-meta'><span>Reported " + escapeHtml(formatDate(report.created_at)) + escapeHtml(status) + "</span></div>" +
          "<div class='auth-actions'>" + hideAction + topicActions + resolveAction + "</div></article>";
      }).join('');
      setMessage(message, targets.length + ' open report(s).');
    } catch (_) {
      list.innerHTML = '';
      setMessage(message, 'The moderation queue could not be loaded. Confirm the account has an admin or moderator role.', 'error');
    }
  }

  async function handleModerationAction(button) {
    if (!user || !['admin', 'moderator'].includes(String(user.app_metadata && user.app_metadata.role || '').toLowerCase())) return;
    const action = button.getAttribute('data-mod-action');
    const targetId = button.getAttribute('data-target-id');
    const reportId = button.getAttribute('data-report-id');
    button.disabled = true;
    try {
      if (action === 'resolve-report' && validUuid(reportId)) {
        await api.rest('forum_reports?id=eq.' + encodeURIComponent(reportId), {
          method: 'PATCH',
          body: { status: 'resolved', resolved_by: user.id, resolved_at: new Date().toISOString() },
          prefer: 'return=minimal'
        });
      } else if ((action === 'hide-topic' || action === 'hide-reply') && validUuid(targetId)) {
        const table = action === 'hide-topic' ? 'forum_topics' : 'forum_replies';
        await api.rest(table + '?id=eq.' + encodeURIComponent(targetId), {
          method: 'PATCH', body: { is_hidden: true }, prefer: 'return=minimal'
        });
      } else if (action === 'lock-topic' && validUuid(targetId)) {
        const topic = await api.rest('forum_topics?select=id,is_locked&id=eq.' + encodeURIComponent(targetId) + '&limit=1');
        const row = Array.isArray(topic) ? topic[0] : null;
        if (!row) throw new Error('Topic not found');
        await api.rest('forum_topics?id=eq.' + encodeURIComponent(targetId), {
          method: 'PATCH', body: { is_locked: !row.is_locked }, prefer: 'return=minimal'
        });
      } else {
        throw new Error('Invalid moderation action');
      }
      setMessage($('#forum-moderation-message'), 'Moderation action saved.', 'success');
      await loadModerationQueue();
      await loadTopics();
      if (activeTopic) {
        const current = topics.find(function (item) { return item.id === activeTopic.id; });
        if (!current || current.is_hidden) {
          activeTopic = null;
          $('#forum-thread-panel').hidden = true;
          $('.topics-panel').hidden = false;
        }
      }
    } catch (_) {
      setMessage($('#forum-moderation-message'), 'The action could not be saved. Check moderator permissions and try again.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function refreshAuthState() {
    user = api && api.getSession() ? api.getSession().user : null;
    const signedIn = Boolean(user && validUuid(user.id));
    const isModerator = Boolean(user && ['admin', 'moderator'].includes(String(user.app_metadata && user.app_metadata.role || '').toLowerCase()));
    $('#forum-moderation-panel').hidden = !isModerator;
    if (isModerator) loadModerationQueue();
    $('#account-state').textContent = signedIn ? 'Signed in' : 'Not signed in';
    $('#forum-auth-email').closest('label').hidden = signedIn;
    $('#forum-auth-password').closest('label').hidden = signedIn;
    $('#forum-sign-in').hidden = signedIn;
    $('#forum-sign-up').hidden = signedIn;
    $('#forum-sign-out').hidden = !signedIn;
    $('#forum-profile-panel').hidden = !signedIn;
    $('#forum-new-topic-toggle').disabled = !signedIn;
    document.querySelectorAll('.forum-request-form button[type="submit"]').forEach(function(button){button.disabled=!signedIn;});
    $('#forum-reply-form').hidden = !signedIn || !activeTopic || activeTopic.is_locked;
    if (signedIn) {
      try {
        await loadProfile();
        setMessage($('#forum-auth-message'), 'Signed in. Your email and private ECU orders are not shown publicly.', 'success');
        loadCustomerRequests();
      } catch (_) {
        profile = null;
        setMessage($('#forum-profile-message'), 'Profile could not be loaded. Try refreshing or signing in again.', 'error');
      }
    } else {
      profile = null;
      setMessage($('#forum-auth-message'), 'Sign in or create an account to post and reply.');
      setMessage($('#forum-profile-message'), '');
      $('#forum-request-send').disabled = true;
      $('#forum-request-list').textContent = 'Sign in to view requests.';
    }
  }

  async function openTopic(topicId) {
    if (!validUuid(topicId)) return;
    let topic = topics.find(function (item) { return item.id === topicId; });
    try {
      const found = await api.rest('forum_topics?select=id,category_id,author_id,title,body,is_pinned,is_locked,accepted_reply_id,created_at&id=eq.' + encodeURIComponent(topicId) + '&limit=1');
      if (Array.isArray(found) && found.length) topic = found[0];
    } catch (_) {}
    if (!topic) {
      setMessage(topicsMessage, 'That topic is unavailable or has been hidden by moderation.', 'error');
      return;
    }
    activeTopic = topic;
    $('#forum-topics-heading');
    $('#forum-thread-title').textContent = topic.title;
    const category = categories.find(function (item) { return item.id === topic.category_id; });
    $('#forum-thread-category').textContent = category ? category.title : 'Workshop discussion';
    $('#forum-thread-meta').textContent = 'By ' + displayNameFor(topic.author_id, topicList._profiles || {}) + ' · ' + formatDate(topic.created_at) + (topic.is_pinned ? ' · Pinned' : '');
    $('#forum-thread-body').textContent = topic.body;
    $('#forum-thread-category').textContent = (category ? category.title : 'Workshop discussion') + (topic.accepted_reply_id ? ' · SOLVED' : '');
    $('#forum-report-topic').hidden = !user;
    $('#forum-topics-heading');
    $('.topics-panel').hidden = true;
    $('#forum-new-topic-panel').hidden = true;
    $('#forum-thread-panel').hidden = false;
    $('#forum-reply-form').hidden = !user || topic.is_locked;
    if (topic.is_locked) setMessage($('#forum-reply-form-message'), 'This topic is locked by a moderator.');
    else setMessage($('#forum-reply-form-message'), '');
    await loadReplies(topic.id);
    window.scrollTo({ top: $('#forum-thread-panel').getBoundingClientRect().top + window.scrollY - 12, behavior: 'smooth' });
  }

  async function loadReplies(topicId) {
    const list = $('#forum-reply-list');
    const message = $('#forum-replies-message');
    list.innerHTML = '';
    setMessage(message, 'Loading replies…');
    try {
      const rows = await api.rest('forum_replies?select=id,topic_id,author_id,body,is_hidden,created_at&topic_id=eq.' + encodeURIComponent(topicId) + '&order=created_at.asc&limit=200');
      const replies = Array.isArray(rows) ? rows : [];
      const profiles = await profilesFor(replies.map(function (reply) { return reply.author_id; }));
      $('#forum-reply-count').textContent = replies.length + (replies.length === 1 ? ' reply' : ' replies');
      setMessage(message, replies.length ? '' : 'No replies yet. Share a useful test result or a clarifying question.');
      list.innerHTML = replies.map(function (reply) {
        return "<article class='reply-card" + (activeTopic.accepted_reply_id === reply.id ? " accepted-solution-card" : "") + "'><div class='reply-card-head'><strong>" + escapeHtml(displayNameFor(reply.author_id, profiles)) + "</strong><span>" + (activeTopic.accepted_reply_id === reply.id ? "<span class='topic-tag'>ACCEPTED SOLUTION</span> " : "") + escapeHtml(formatDate(reply.created_at)) + "</span></div>" +
          "<p class='reply-card-body'>" + escapeHtml(reply.body) + "</p>" +
          ((user && activeTopic && activeTopic.author_id === user.id) ? "<div class='reply-card-actions'><button type='button' class='button button-outline accept-solution' data-reply-id='" + escapeHtml(reply.id) + "'>" + (activeTopic.accepted_reply_id === reply.id ? 'Unmark solution' : 'Accept solution') + "</button> <button type='button' class='plain-report report-reply' data-reply-id='" + escapeHtml(reply.id) + "'>Report reply</button></div>" : (user ? "<div class='reply-card-actions'><button type='button' class='plain-report report-reply' data-reply-id='" + escapeHtml(reply.id) + "'>Report reply</button></div>" : '')) +
          "</article>";
      }).join('');
    } catch (_) {
      $('#forum-reply-count').textContent = 'Replies';
      friendlyReadError(message);
    }
  }

  async function submitReport(topicId, replyId) {
    if (!user) {
      window.alert('Sign in before sending a report.');
      return;
    }
    const reason = window.prompt('Briefly explain why this content should be reviewed. Do not include private customer data.');
    if (reason === null) return;
    if (reason.trim().length < 10 || reason.trim().length > 1000) {
      window.alert('Please enter a reason between 10 and 1000 characters.');
      return;
    }
    try {
      await api.rest('forum_reports', {
        method: 'POST',
        body: { reporter_id: user.id, topic_id: topicId || null, reply_id: replyId || null, reason: reason.trim() },
        prefer: 'return=minimal'
      });
      window.alert('Report submitted privately for moderator review.');
    } catch (_) {
      window.alert('The report could not be submitted. It may already exist or the item may no longer be available.');
    }
  }

  $('#forum-auth-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!api) {
      setMessage($('#forum-auth-message'), 'Account service is unavailable. Please try again later.', 'error');
      return;
    }
    const email = $('#forum-auth-email').value.trim();
    const password = $('#forum-auth-password').value;
    $('#forum-sign-in').disabled = true;
    try {
      await api.signIn(email, password);
      $('#forum-auth-password').value = '';
      await refreshAuthState();
      await loadTopics();
    } catch (_) {
      setMessage($('#forum-auth-message'), 'Sign-in failed. Check the credentials and try again.', 'error');
    } finally {
      $('#forum-sign-in').disabled = false;
    }
  });

  $('#forum-sign-up').addEventListener('click', async function () {
    if (!api) return setMessage($('#forum-auth-message'), 'Account service is unavailable. Please try again later.', 'error');
    const email = $('#forum-auth-email').value.trim();
    const password = $('#forum-auth-password').value;
    if (!email || password.length < 8) return setMessage($('#forum-auth-message'), 'Enter a valid email and a password with at least 8 characters.', 'error');
    $('#forum-sign-up').disabled = true;
    try {
      const result = await api.signUp(email, password);
      $('#forum-auth-password').value = '';
      await refreshAuthState();
      if (result && result.access_token) {
        setMessage($('#forum-auth-message'), 'Account created. Set your public display name before posting.', 'success');
      } else {
        setMessage($('#forum-auth-message'), 'Account request received. Verify your email if confirmation is enabled, then sign in.', 'success');
      }
    } catch (_) {
      setMessage($('#forum-auth-message'), 'Account creation could not be completed. Check the details or try signing in if you already have an account.', 'error');
    } finally {
      $('#forum-sign-up').disabled = false;
    }
  });

  $('#forum-sign-out').addEventListener('click', async function () {
    try { await api.signOut(); } catch (_) {}
    activeTopic = null;
    $('#forum-thread-panel').hidden = true;
    $('.topics-panel').hidden = false;
    await refreshAuthState();
    await loadTopics();
  });

  $('#forum-profile-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!user || !validUuid(user.id)) return setMessage($('#forum-profile-message'), 'Sign in before saving your profile.', 'error');
    const displayName = $('#forum-display-name').value.trim();
    const bio = $('#forum-bio').value.trim();
    if (displayName.length < 2 || displayName.length > 32 || bio.length > 240) {
      return setMessage($('#forum-profile-message'), 'Use a display name of 2–32 characters and a bio under 240 characters.', 'error');
    }
    try {
      await api.rest('forum_profiles?on_conflict=user_id', {
        method: 'POST',
        body: { user_id: user.id, display_name: displayName, bio: bio },
        prefer: 'resolution=merge-duplicates,return=representation'
      });
      await loadProfile();
      await loadTopics();
      setMessage($('#forum-profile-message'), 'Public profile saved.', 'success');
    } catch (_) {
      setMessage($('#forum-profile-message'), 'Profile could not be saved. The display name may already be in use.', 'error');
    }
  });

  $('#forum-new-topic-toggle').addEventListener('click', function () {
    if (!user) return;
    $('#forum-thread-panel').hidden = true;
    $('#forum-new-topic-panel').hidden = false;
    $('#forum-new-topic-title').focus();
  });
  $('#forum-cancel-topic').addEventListener('click', function () {
    $('#forum-new-topic-panel').hidden = true;
  });

  $('#forum-new-topic-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!user) return setMessage($('#forum-create-message'), 'Sign in before creating a topic.', 'error');
    if (!profile) return setMessage($('#forum-create-message'), 'Save your public display name before creating a topic.', 'error');
    const categoryId = $('#forum-new-topic-category').value;
    const title = $('#forum-new-topic-title').value.trim();
    const body = $('#forum-new-topic-body').value.trim();
    if (!validUuid(categoryId) || title.length < 8 || title.length > 160 || body.length < 20 || body.length > 12000) {
      return setMessage($('#forum-create-message'), 'Choose a category, use a title of 8–160 characters and details of 20–12,000 characters.', 'error');
    }
    const button = $('#forum-new-topic-form').querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const created = await api.rest('forum_topics?select=id,category_id,author_id,title,body,is_pinned,is_locked,created_at', {
        method: 'POST',
        body: { category_id: categoryId, author_id: user.id, title: title, body: body },
        prefer: 'return=representation'
      });
      const newTopic = Array.isArray(created) ? created[0] : created;
      $('#forum-new-topic-form').reset();
      $('#forum-new-topic-panel').hidden = true;
      setMessage(topicsMessage, 'Topic published.', 'success');
      await loadTopics();
      if (newTopic && validUuid(newTopic.id)) await openTopic(newTopic.id);
    } catch (_) {
      setMessage($('#forum-create-message'), 'Topic could not be published. Check the category and sign-in, or try again later.', 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#forum-topic-list').addEventListener('click', function (event) {
    const button = event.target.closest('.topic-open');
    if (button) openTopic(button.getAttribute('data-topic-id'));
  });
  categoryFilter.addEventListener('change', renderTopics);
  if (statusFilter) statusFilter.addEventListener('change', renderTopics);
  searchInput.addEventListener('input', renderTopics);

  $('#forum-back-topics').addEventListener('click', function () {
    activeTopic = null;
    $('#forum-thread-panel').hidden = true;
    $('.topics-panel').hidden = false;
    setMessage(topicsMessage, '');
    window.scrollTo({ top: $('.topics-panel').getBoundingClientRect().top + window.scrollY - 12, behavior: 'smooth' });
  });
  $('#forum-load-topics').addEventListener('click', loadTopics);
  $('#forum-refresh-reports').addEventListener('click', loadModerationQueue);
  $('#forum-moderation-list').addEventListener('click', function (event) {
    const button = event.target.closest('[data-mod-action]');
    if (button) handleModerationAction(button);
  });
  $('#forum-report-topic').addEventListener('click', function () {
    if (activeTopic) submitReport(activeTopic.id, null);
  });
  $('#forum-reply-list').addEventListener('click', async function (event) {
    const acceptButton = event.target.closest('.accept-solution');
    if (acceptButton && activeTopic && user && activeTopic.author_id === user.id) {
      const replyId = acceptButton.getAttribute('data-reply-id');
      acceptButton.disabled = true;
      try {
        await api.rest('rpc/forum_set_accepted_reply', { method: 'POST', body: { p_topic_id: activeTopic.id, p_reply_id: activeTopic.accepted_reply_id === replyId ? null : replyId }, prefer: 'return=representation' });
        const result = await api.rest('forum_topics?select=id,category_id,author_id,title,body,is_pinned,is_locked,accepted_reply_id,created_at&id=eq.' + encodeURIComponent(activeTopic.id) + '&limit=1');
        const updated = Array.isArray(result) ? result[0] : null;
        if (!updated) throw new Error('Topic unavailable');
        activeTopic = updated;
        const topicIndex = topics.findIndex(function (item) { return item.id === updated.id; });
        if (topicIndex >= 0) topics[topicIndex].accepted_reply_id = updated.accepted_reply_id;
        setMessage($('#forum-replies-message'), updated.accepted_reply_id ? 'Accepted solution saved.' : 'Accepted solution removed.', 'success');
        await loadReplies(activeTopic.id);
        renderTopics();
      } catch (_) {
        setMessage($('#forum-replies-message'), 'Could not update the accepted solution. Only the topic author can change it.', 'error');
      } finally { acceptButton.disabled = false; }
      return;
    }
    const button = event.target.closest('.report-reply');
    if (button && activeTopic) submitReport(null, button.getAttribute('data-reply-id'));
  });

  $('#forum-reply-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!user || !activeTopic || activeTopic.is_locked) return;
    if (!profile) return setMessage($('#forum-reply-form-message'), 'Save your public display name before replying.', 'error');
    const body = $('#forum-reply-body').value.trim();
    if (body.length < 2 || body.length > 8000) return setMessage($('#forum-reply-form-message'), 'Replies must be 2–8,000 characters.', 'error');
    const button = $('#forum-reply-form').querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api.rest('forum_replies', {
        method: 'POST',
        body: { topic_id: activeTopic.id, author_id: user.id, body: body },
        prefer: 'return=minimal'
      });
      $('#forum-reply-body').value = '';
      setMessage($('#forum-reply-form-message'), 'Reply posted.', 'success');
      await loadReplies(activeTopic.id);
      await loadTopics();
    } catch (_) {
      setMessage($('#forum-reply-form-message'), 'Reply could not be posted. The topic may be locked, moderated or temporarily unavailable.', 'error');
    } finally {
      button.disabled = false;
    }
  });


  // Public live workshop chat: real authenticated messages only; no fabricated members.
  const chatList = $('#forum-chat-list');
  const chatForm = $('#forum-chat-form');
  const chatInput = $('#forum-chat-input');
  const chatSend = $('#forum-chat-send');
  const chatStatus = $('#forum-chat-status');
  let chatRefreshBusy = false;
  let chatMessagesById = {};
  let selectedChatReply = null;
  let chatProfilesCache = {};
  function renderChatMessage(row, displayName, profiles) {
    const article = document.createElement('article'); article.className = 'forum-chat-message'; article.setAttribute('data-chat-message-id', row.id);
    const head = document.createElement('div'); head.className = 'forum-chat-message-head';
    const who = document.createElement('strong'); who.textContent = displayName || 'Community member';
    const time = document.createElement('time'); time.dateTime = row.created_at || ''; time.textContent = formatDate(row.created_at);
    const body = document.createElement('p'); body.textContent = row.body || ''; head.append(who,time); article.append(head,body);
    if (row.reply_to_message_id) { const parent=chatMessagesById[row.reply_to_message_id]; const reference=document.createElement('div'); reference.className='chat-reply-reference';
      if(parent){const label=document.createElement('strong');label.textContent='Replying to '+displayNameFor(parent.author_id,profiles)+': ';const preview=document.createElement('span');preview.textContent=String(parent.body||'').slice(0,220)+(String(parent.body||'').length>220?'…':'');reference.append(label,preview);}
      else reference.textContent='Reply to an earlier community message'; article.append(reference);}
    if(user){const reply=document.createElement('button');reply.type='button';reply.className='chat-reply-button';reply.setAttribute('data-reply-chat-id',row.id);reply.textContent='Reply ↩';article.append(reply);}
    return article;
  }
  async function loadChatMessages() {
    if (!api || !chatList || chatRefreshBusy) return;
    chatRefreshBusy = true;
    try {
      const rows = await api.rest('forum_chat_messages?select=id,author_id,body,created_at,reply_to_message_id&order=created_at.desc&limit=100');
      const messages = Array.isArray(rows) ? rows.slice().reverse() : [];
      chatMessagesById = {}; messages.forEach(function(row){chatMessagesById[row.id]=row;});
      const missing=Array.from(new Set(messages.map(function(row){return row.reply_to_message_id;}).filter(function(id){return id&&!chatMessagesById[id]&&validUuid(id);})));
      if(missing.length){try{const parents=await api.rest('forum_chat_messages?select=id,author_id,body,created_at&id=in.('+missing.join(',')+')');(Array.isArray(parents)?parents:[]).forEach(function(row){chatMessagesById[row.id]=row;});}catch(_){}}
      const ids=messages.map(function(row){return row.author_id;}).concat(Object.values(chatMessagesById).map(function(row){return row.author_id;}));
      const profiles=await profilesFor(ids); chatProfilesCache=profiles;
      const nearBottom=chatList.scrollHeight-chatList.scrollTop-chatList.clientHeight<100;
      chatList.replaceChildren();
      if(!messages.length){const empty=document.createElement('div');empty.className='forum-chat-message empty';empty.textContent='No live messages yet. Sign in and start the first real conversation.';chatList.append(empty);}
      else {messages.forEach(function(row){chatList.append(renderChatMessage(row,displayNameFor(row.author_id,profiles),profiles));});if(nearBottom)chatList.scrollTop=chatList.scrollHeight;}
      if(chatStatus)chatStatus.textContent=user?'Signed in. Use Reply to mention the member you are answering.':'Sign in to post. Public messages are visible to visitors.';
      if(chatSend)chatSend.disabled=!user;
    } catch (_) {chatList.replaceChildren();const empty=document.createElement('div');empty.className='forum-chat-message empty';empty.textContent='Live chat is temporarily unavailable. You can still search and read workshop topics below.';chatList.append(empty);}
    finally {chatRefreshBusy=false;}
  }
  function assistantReply(message) {
    const q = message.toLowerCase();
    if (/dtc|fault code|p0[0-9a-f]{3}/i.test(q)) return 'Community Assistant (automated): Please include the exact DTC, vehicle year/engine, ECU part number, freeze-frame data and tests already performed. Verify the next step against authoritative service information; this is not a confirmed diagnosis.';
    if (/ecu|edc|md1|dcm|bosch|denso/i.test(q)) return 'Community Assistant (automated): Please share the ECU label/part number, HW/SW identifiers, vehicle details and read method. Keep the original file unchanged and do not post customer identifiers or paid files.';
    if (/airbag|srs|crash/i.test(q)) return 'Community Assistant (automated): SRS is a safety-critical system. Follow the manufacturer procedure and applicable law; verify the module and fault data before any repair. Do not bypass safety restraints.';
    return 'Community Assistant (automated): To help other technicians respond, add vehicle/year/engine, ECU or module number, exact fault/symptom, measurements and steps already tried. This automated note is not a human member or a verified repair answer.';
  }
  if(chatList)chatList.addEventListener('click',function(event){const button=event.target.closest('[data-reply-chat-id]');if(!button)return;const row=chatMessagesById[button.getAttribute('data-reply-chat-id')];if(!row)return;selectedChatReply=row;const context=$('#forum-chat-reply-context');context.replaceChildren();const label=document.createElement('span');label.textContent='Replying to '+displayNameFor(row.author_id,chatProfilesCache)+': '+String(row.body||'').slice(0,140);const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel reply';cancel.addEventListener('click',function(){selectedChatReply=null;context.hidden=true;});context.append(label,cancel);context.hidden=false;chatInput.focus();chatInput.placeholder='Write a reply to this member…';});
  if (chatForm) chatForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!api || !user) { if (chatStatus) chatStatus.textContent = 'Please sign in above to post to the public chat.'; return; }
    const body = String(chatInput.value || '').trim();
    if (!body || body.length > 1200) { if (chatStatus) chatStatus.textContent = 'Messages must be 1–1,200 characters.'; return; }
    chatSend.disabled = true;
    try {
      await api.rest('forum_chat_messages', { method: 'POST', body: { author_id: user.id, body: body, reply_to_message_id: selectedChatReply ? selectedChatReply.id : null }, prefer: 'return=minimal' });
      chatInput.value = ''; selectedChatReply = null; $('#forum-chat-reply-context').hidden = true; chatInput.placeholder = 'Ask a concise diagnostic question. Never share VINs, passwords or customer data.'; if (chatStatus) chatStatus.textContent = 'Message posted.';
      await loadChatMessages();
      // A transparent, clearly labelled automated prompt is shown locally only; it never impersonates a user or writes fake chat history.
      const assistant = document.createElement('article'); assistant.className = 'forum-chat-message assistant';
      const head = document.createElement('div'); head.className = 'forum-chat-message-head';
      const label = document.createElement('strong'); label.className = 'assistant-label'; label.textContent = 'Community Assistant · automated';
      const bodyNode = document.createElement('p'); bodyNode.textContent = assistantReply(body);
      head.append(label); assistant.append(head, bodyNode); chatList.append(assistant); chatList.scrollTop = chatList.scrollHeight;
    } catch (_) { if (chatStatus) chatStatus.textContent = 'Message could not be posted. Check your sign-in or try again shortly.'; }
    finally { chatSend.disabled = !user; }
  });
  loadChatMessages();
  window.setInterval(loadChatMessages, 12000);


  // Separate private request boxes; row-level security restricts access to the requester and authorized moderators.
  const requestForms=Array.from(document.querySelectorAll('.forum-request-form[data-request-type]')),requestList=$('#forum-request-list'),requestMessage=$('#forum-request-message');
  function requestTypeLabel(v){return({suggestion:'Suggestions & general requirements',service_requirement:'Service requirement',feature_request:'Website / forum feature',software_requirement:'Software requirement',wiring_diagram:'Wiring diagram requirement',issue:'Problem / complaint',other:'Other'})[v]||'Request';}
  async function loadCustomerRequests(){
    if(!api||!user||!requestList)return;requestList.replaceChildren();const loading=document.createElement('p');loading.className='muted';loading.textContent='Loading request history…';requestList.append(loading);
    try{const rows=await api.rest('forum_customer_requests?select=id,user_id,request_type,title,body,status,admin_reply,customer_auto_reply,created_at,updated_at&order=created_at.desc&limit=100');requestList.replaceChildren();
      if(!Array.isArray(rows)||!rows.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No requests yet. Use one of the three private request boxes above.';requestList.append(empty);return;}
      const moderator=['admin','moderator'].includes(String(user.app_metadata&&user.app_metadata.role||'').toLowerCase());
      rows.forEach(function(row){const card=document.createElement('article');card.className='forum-request-card';const head=document.createElement('div');head.className='forum-request-card-head';const type=document.createElement('span');type.className='topic-tag';type.textContent=requestTypeLabel(row.request_type);const status=document.createElement('span');status.className='state-pill';status.textContent=String(row.status||'open').replace(/_/g,' ');head.append(type,status);
        const title=document.createElement('h4');title.textContent=row.title||'Customer request';const body=document.createElement('p');body.textContent=row.body||'';const date=document.createElement('p');date.className='muted';date.textContent='Submitted '+formatDate(row.created_at);card.append(head,title,body,date);
        if(row.customer_auto_reply){const ack=document.createElement('p');ack.className='request-admin-reply';ack.textContent=row.customer_auto_reply;card.append(ack);}if(row.admin_reply){const reply=document.createElement('p');reply.className='request-admin-reply';reply.textContent='ECU SOLUTION reply: '+row.admin_reply;card.append(reply);}
        if(moderator){const controls=document.createElement('div');controls.className='forum-request-admin-controls';const replyInput=document.createElement('textarea');replyInput.maxLength=4000;replyInput.placeholder='Write a private reply to the customer';replyInput.value=row.admin_reply||'';const select=document.createElement('select');['open','in_review','waiting_for_customer','resolved','closed'].forEach(function(v){const o=document.createElement('option');o.value=v;o.textContent=v.replace(/_/g,' ');select.append(o);});select.value=row.status||'open';const save=document.createElement('button');save.type='button';save.className='button button-lime';save.textContent='Save admin reply';save.addEventListener('click',async function(){save.disabled=true;try{await api.rest('forum_customer_requests?id=eq.'+encodeURIComponent(row.id),{method:'PATCH',body:{admin_reply:replyInput.value.trim(),status:select.value,updated_at:new Date().toISOString()},prefer:'return=minimal'});setMessage(requestMessage,'Private admin reply saved.','success');await loadCustomerRequests();}catch(_){setMessage(requestMessage,'Could not save reply. Verify moderator permissions and migration.','error');}finally{save.disabled=false;}});controls.append(replyInput,select,save);card.append(controls);}
        requestList.append(card);
      });
    }catch(_){requestList.replaceChildren();const error=document.createElement('p');error.className='status-message error';error.textContent='Request history is not available yet. The private-request database migration must be applied.';requestList.append(error);}
  }
  requestForms.forEach(function(form){form.addEventListener('submit',async function(event){event.preventDefault();if(!user)return setMessage(requestMessage,'Sign in to send a private request.','error');const data=new FormData(form),type=form.dataset.requestType,title=String(data.get('title')||'').trim(),body=String(data.get('body')||'').trim();if(title.length<4||body.length<10||body.length>4000)return setMessage(requestMessage,'Add a clear subject and at least 10 characters of detail.','error');const button=form.querySelector('button[type="submit"]');button.disabled=true;
    try{await api.rest('forum_customer_requests',{method:'POST',body:{user_id:user.id,request_type:type,title:title,body:body},prefer:'return=minimal'});form.reset();setMessage(requestMessage,'Request sent privately. Please open My Account → My requests & messages to see confirmation and later replies.','success');await loadCustomerRequests();}
    catch(_){setMessage(requestMessage,'Could not send the request. Please check sign-in or try again shortly.','error');}
    finally{button.disabled=!user;}
  });});
  $('#forum-request-refresh').addEventListener('click',loadCustomerRequests);

  // Display only active, admin-published sidebar promotions from the existing site-content system.
  (function loadForumSidebarPromotion() {
    const slot = $('#forum-sidebar-ad-slot');
    const target = $('#forum-sidebar-ad-content');
    if (!slot || !target) return;
    const safeHttps = function (value) {
      try { const url = new URL(value, window.location.origin); return url.protocol === 'https:' ? url.href : null; }
      catch (_) { return null; }
    };
    fetch('/api/site-content', { headers: { Accept: 'application/json' } }).then(async function (response) {
      if (!response.ok) throw new Error('promotion unavailable');
      const data = await response.json();
      const item = (Array.isArray(data.items) ? data.items : []).find(function (entry) {
        return entry.placement === 'sidebar' && entry.kind === 'ad';
      });
      if (!item) return;
      target.replaceChildren();
      const heading = document.createElement('h3'); heading.textContent = item.title || 'Sponsored workshop resource';
      const body = document.createElement('p'); body.textContent = item.body || '';
      target.append(heading);
      const imageUrl = safeHttps(item.image_url);
      if (imageUrl) { const image = document.createElement('img'); image.src = imageUrl; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; target.append(image); }
      target.append(body);
      const href = safeHttps(item.cta_url);
      if (href && item.cta_label) { const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer sponsored'; link.textContent = item.cta_label + ' ↗'; target.append(link); }
      slot.hidden = false;
    }).catch(function () { /* Ads are optional; a failed ad request must not affect forum use. */ });
  })();

  $('#forum-year').textContent = String(new Date().getFullYear());
  if (!api) {
    setMessage($('#forum-auth-message'), 'Account service is unavailable. The forum cannot be used until setup is complete.', 'error');
    setMessage(topicsMessage, 'Forum setup is pending.', 'error');
  } else {
    Promise.resolve().then(async function () {
      try {
        await loadCategories();
        await refreshAuthState();
        await loadTopics();
      } catch (_) {
        friendlyReadError(topicsMessage);
      }
    });
  }
})();