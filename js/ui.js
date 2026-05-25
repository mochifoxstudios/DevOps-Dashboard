/* DevOps Dashboard — UI shell wiring.
   Handles view switching, segmented controls, settings rail (click + scroll-spy),
   accent / theme / density, range sliders, help search + jump tiles,
   profile modal, login screen, popovers (workspace + notifications),
   command palette (⌘K), and global keyboard shortcuts. */

(function () {
  var D = window.DevOps;
  if (!D) { console.error('[DevOps] core.js must load before ui.js'); return; }

  // --------- View switching ---------
  var navItems = document.querySelectorAll('.nav-item[data-view]');
  var views = document.querySelectorAll('.view');
  var crumbCurrent = document.getElementById('crumb-current');

  D.activate = function (viewId) {
    navItems.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === viewId);
    });
    views.forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-' + viewId);
    });
    if (crumbCurrent && D.labels[viewId]) crumbCurrent.textContent = D.labels[viewId];
  };

  navItems.forEach(function (btn) {
    btn.addEventListener('click', function () {
      D.activate(btn.getAttribute('data-view'));
    });
  });

  // --------- Generic segmented controls ---------
  document.querySelectorAll('.seg').forEach(function (seg) {
    seg.querySelectorAll('.seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        seg.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      });
    });
  });

  // --------- Settings rail: click-to-scroll + scroll-spy ---------
  var workspace = document.querySelector('.workspace');
  var settingsRail = document.querySelector('#view-settings .settings-rail');
  var settingsRailItems = settingsRail ? settingsRail.querySelectorAll('.settings-rail-item') : [];

  D.setActiveRailItem = function (id) {
    settingsRailItems.forEach(function (x) {
      x.classList.toggle('active', x.getAttribute('data-section') === id);
    });
  };

  D.scrollSettingsTo = function (id) {
    var section = document.getElementById(id);
    if (!section || !workspace) return;
    var top = section.getBoundingClientRect().top
            - workspace.getBoundingClientRect().top
            + workspace.scrollTop - 12;
    workspace.scrollTo({ top: top, behavior: 'smooth' });
  };

  // Cross-view jump used by Release notes button.
  D.scrollWorkspaceTo = function (selector) {
    var target = document.querySelector(selector);
    if (!target || !workspace) return;
    var top = target.getBoundingClientRect().top
            - workspace.getBoundingClientRect().top
            + workspace.scrollTop - 12;
    workspace.scrollTo({ top: top, behavior: 'smooth' });
  };

  settingsRailItems.forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-section');
      if (!id) return;
      D.setActiveRailItem(id);
      D.state.suppressSpy = true;
      D.scrollSettingsTo(id);
      clearTimeout(D.state.suppressTimer);
      D.state.suppressTimer = setTimeout(function () { D.state.suppressSpy = false; }, 700);
    });
  });

  var settingsSections = document.querySelectorAll('#view-settings .settings-group[id]');
  if ('IntersectionObserver' in window && workspace && settingsSections.length) {
    var io = new IntersectionObserver(function (entries) {
      if (D.state.suppressSpy) return;
      var visible = entries
        .filter(function (e) { return e.isIntersecting; })
        .map(function (e) { return e.target; });
      if (!visible.length) return;
      visible.sort(function (a, b) {
        return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      });
      D.setActiveRailItem(visible[0].id);
    }, { root: workspace, rootMargin: '-15% 0px -65% 0px', threshold: 0 });
    settingsSections.forEach(function (s) { io.observe(s); });
  }

  // --------- Appearance: accent picker ---------
  var accentPicker = document.getElementById('accentPicker');
  if (accentPicker) {
    accentPicker.querySelectorAll('[data-accent]').forEach(function (swatch) {
      swatch.addEventListener('click', function () {
        var c = swatch.getAttribute('data-accent');
        document.documentElement.style.setProperty('--accent-indigo', c);
        document.documentElement.style.setProperty('--accent-indigo-soft', D.hexToRgba(c, 0.12));
        document.documentElement.style.setProperty('--accent-indigo-ring', D.hexToRgba(c, 0.35));
        accentPicker.querySelectorAll('[data-accent]').forEach(function (s) {
          s.style.border = '1px solid var(--border)';
          s.style.boxShadow = 'none';
        });
        swatch.style.border = '2px solid #fff';
        swatch.style.boxShadow = '0 0 0 1px ' + c;
      });
    });
  }

  // --------- Appearance: theme + density + monospace font ---------
  var appearanceCard = document.getElementById('s-appearance');
  if (appearanceCard) {
    var segs = appearanceCard.querySelectorAll('.seg');
    var themeSeg = segs[0], densitySeg = segs[1];
    if (themeSeg) {
      themeSeg.querySelectorAll('.seg-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          var label = b.textContent.trim().toLowerCase();
          document.body.classList.remove('theme-light', 'theme-dark');
          if (label === 'light') document.body.classList.add('theme-light');
          else if (label === 'system') {
            var preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            if (!preferDark) document.body.classList.add('theme-light');
          }
        });
      });
    }
    if (densitySeg) {
      densitySeg.querySelectorAll('.seg-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          var label = b.textContent.trim().toLowerCase();
          document.body.classList.remove('density-compact', 'density-cozy', 'density-spacious');
          document.body.classList.add('density-' + label);
        });
      });
    }
    var monoSelect = appearanceCard.querySelector('select');
    if (monoSelect) {
      monoSelect.addEventListener('change', function () {
        var f = monoSelect.value;
        var stack = '"' + f + '", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
        document.documentElement.style.setProperty('--font-mono', stack);
      });
    }
  }

  // --------- Range slider live value pills ---------
  document.querySelectorAll('input[type="range"]').forEach(function (range) {
    var pill = range.parentElement && range.parentElement.querySelector('.kbd-pill');
    if (!pill) return;
    var initial = pill.textContent.trim();
    var unit = initial.replace(/[\d.\s]/g, '');
    var format = function (v) {
      if (unit === '%') return v + '%';
      if (unit === 'MB' || unit === 'GB') {
        var n = parseInt(v, 10);
        if (n >= 1024) return (n / 1024).toFixed(n % 1024 === 0 ? 0 : 1) + ' GB';
        return n + ' MB';
      }
      return v + (unit ? ' ' + unit : '');
    };
    range.addEventListener('input', function () { pill.textContent = format(range.value); });
  });

  // --------- Help: live search + quick-start tile jump ---------
  var helpSearch = document.getElementById('helpSearch');
  var helpNoResults = document.getElementById('helpNoResults');
  var helpView = document.getElementById('view-help');

  function runHelpSearch() {
    if (!helpView) return;
    var q = (helpSearch.value || '').trim().toLowerCase();
    var anyVisible = false;

    helpView.querySelectorAll('.help-tile').forEach(function (tile) {
      var text = tile.textContent.toLowerCase();
      var match = !q || text.indexOf(q) !== -1;
      tile.style.display = match ? '' : 'none';
      if (match) anyVisible = true;
    });

    var qsBlock = helpView.querySelector('[data-help-block="quick-start"]');
    if (qsBlock) {
      var anyTile = Array.prototype.some.call(qsBlock.querySelectorAll('.help-tile'), function (t) {
        return t.style.display !== 'none';
      });
      qsBlock.style.display = anyTile ? '' : 'none';
    }

    helpView.querySelectorAll('.guide-item[data-help-row]').forEach(function (g) {
      var text = g.textContent.toLowerCase();
      var match = !q || text.indexOf(q) !== -1;
      g.style.display = match ? '' : 'none';
      if (match) {
        anyVisible = true;
        if (q) g.setAttribute('open', '');
      } else if (q) {
        g.removeAttribute('open');
      }
    });

    helpView.querySelectorAll('.settings-group[data-help-block]').forEach(function (group) {
      if (group.getAttribute('data-help-block') === 'quick-start') return;
      var any = Array.prototype.some.call(group.querySelectorAll('.guide-item, .glossary-term'), function (i) {
        return i.style.display !== 'none';
      });
      if (group.querySelectorAll('.guide-item, .glossary-term').length === 0) return;
      group.style.display = any ? '' : 'none';
    });

    helpView.querySelectorAll('.card[data-help-block] [data-help-row]').forEach(function (row) {
      var text = row.textContent.toLowerCase();
      var match = !q || text.indexOf(q) !== -1;
      row.style.display = match ? '' : 'none';
      if (match) anyVisible = true;
    });

    helpView.querySelectorAll('.glossary-term[data-help-row]').forEach(function (g) {
      var text = g.textContent.toLowerCase();
      var match = !q || text.indexOf(q) !== -1;
      g.style.display = match ? '' : 'none';
      if (match) anyVisible = true;
    });

    helpView.querySelectorAll('.card[data-help-block]').forEach(function (card) {
      var rows = card.querySelectorAll('[data-help-row]');
      if (!rows.length) return;
      var any = Array.prototype.some.call(rows, function (r) {
        return r.style.display !== 'none';
      });
      card.style.display = any ? '' : 'none';
    });

    helpView.querySelectorAll('.help-grid[data-help-block]').forEach(function (grid) {
      var anyCard = Array.prototype.some.call(grid.querySelectorAll('.card'), function (c) {
        return c.style.display !== 'none';
      });
      grid.style.display = (q && !anyCard) ? 'none' : '';
    });

    if (helpNoResults) helpNoResults.style.display = (q && !anyVisible) ? '' : 'none';
  }

  if (helpSearch) {
    helpSearch.addEventListener('input', runHelpSearch);
    helpSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { helpSearch.value = ''; runHelpSearch(); }
    });
  }

  document.querySelectorAll('.help-tile[data-help-jump]').forEach(function (tile) {
    tile.addEventListener('click', function () {
      var target = tile.getAttribute('data-help-jump');
      if (target) D.activate(target);
    });
    tile.style.cursor = 'pointer';
  });

  // --------- Profile modal ---------
  var profileModal = document.getElementById('profileModal');
  var profileTrigger = document.getElementById('profileTrigger');
  D.openProfile = function () { if (profileModal) profileModal.classList.add('open'); };
  D.closeProfile = function () { if (profileModal) profileModal.classList.remove('open'); };
  if (profileTrigger) profileTrigger.addEventListener('click', D.openProfile);
  document.querySelectorAll('[data-close-modal]').forEach(function (b) {
    b.addEventListener('click', D.closeProfile);
  });
  if (profileModal) {
    profileModal.addEventListener('click', function (e) {
      if (e.target === profileModal) D.closeProfile();
    });
  }

  // Profile save → recompute sidebar identity row.
  var profileSaveBtn = profileModal ? profileModal.querySelector('.modal-footer .btn-primary') : null;
  if (profileSaveBtn) {
    profileSaveBtn.addEventListener('click', function () {
      var nameInput = profileModal.querySelector('input[type="text"]');
      var sidebarAvatar = document.querySelector('.sidebar-footer .avatar');
      var sidebarName = document.querySelector('.sidebar-footer .user-name');
      if (nameInput && sidebarName) {
        var name = nameInput.value.trim();
        if (name) {
          sidebarName.textContent = name.split(/\s+/).slice(0, 2).join(' ').toLowerCase().replace(/\s+/, '.');
          if (sidebarAvatar) {
            sidebarAvatar.textContent = name.split(/\s+/).map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase();
          }
        }
      }
      D.closeProfile();
      D.toast('Profile saved');
    });
  }

  // --------- Login screen ---------
  var loginScreen = document.getElementById('loginScreen');
  var loginForm = document.getElementById('loginForm');
  var signOutBtn = document.getElementById('signOutBtn');
  D.showLogin = function () { if (loginScreen) loginScreen.classList.remove('hidden'); };
  D.hideLogin = function () { if (loginScreen) loginScreen.classList.add('hidden'); };
  if (loginForm) {
    loginForm.addEventListener('submit', function (e) { e.preventDefault(); D.hideLogin(); });
  }
  document.querySelectorAll('[data-login]').forEach(function (b) {
    b.addEventListener('click', D.hideLogin);
  });
  if (signOutBtn) {
    signOutBtn.addEventListener('click', function (e) { e.stopPropagation(); D.showLogin(); });
  }

  // Picking a recent updates the header workspace pill.
  document.querySelectorAll('.login-recent').forEach(function (r) {
    r.addEventListener('click', function () {
      var nm = r.querySelector('.nm');
      var pt = r.querySelector('.pt');
      var gl = r.querySelector('.gl');
      if (nm && pt && gl) {
        document.getElementById('wsName').textContent = nm.textContent;
        document.getElementById('wsPath').textContent = pt.textContent.split('·')[0].trim();
        var glyph = document.getElementById('wsGlyph');
        glyph.textContent = gl.textContent;
        glyph.style.background = gl.style.background;
      }
    });
  });

  // --------- Workspace + Notifications popovers ---------
  var wsBtn = document.getElementById('workspaceSwitch');
  var wsPop = document.getElementById('workspacePopover');
  var notifBtn = document.getElementById('notifBtn');
  var notifPop = document.getElementById('notifPopover');

  D.closeAllPopovers = function () {
    if (wsPop) wsPop.classList.remove('open');
    if (notifPop) notifPop.classList.remove('open');
  };

  function togglePop(pop, others) {
    var willOpen = !pop.classList.contains('open');
    (others || []).forEach(function (p) { if (p) p.classList.remove('open'); });
    pop.classList.toggle('open', willOpen);
  }

  if (wsBtn && wsPop) {
    wsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePop(wsPop, [notifPop]);
    });
    wsPop.querySelectorAll('[data-ws]').forEach(function (item) {
      item.addEventListener('click', function () {
        var name = item.getAttribute('data-ws');
        var path = item.getAttribute('data-ws-path');
        var color = item.getAttribute('data-ws-color');
        var initials = item.getAttribute('data-ws-initials');
        document.getElementById('wsName').textContent = name;
        document.getElementById('wsPath').textContent = path;
        var glyph = document.getElementById('wsGlyph');
        glyph.textContent = initials;
        glyph.style.background = color;
        wsPop.querySelectorAll('[data-ws]').forEach(function (x) { x.classList.remove('active'); });
        wsPop.querySelectorAll('.check').forEach(function (c) { c.remove(); });
        item.classList.add('active');
        var check = document.createElement('span');
        check.className = 'check';
        check.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        item.appendChild(check);
        wsPop.classList.remove('open');
      });
    });
  }

  if (notifBtn && notifPop) {
    notifBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePop(notifPop, [wsPop]);
      var dot = document.getElementById('notifDot');
      if (dot && notifPop.classList.contains('open')) dot.style.display = 'none';
    });
    var markRead = document.getElementById('markReadBtn');
    if (markRead) {
      markRead.addEventListener('click', function (e) {
        e.stopPropagation();
        notifPop.querySelectorAll('.notif-dot').forEach(function (d) {
          d.style.background = 'var(--border-strong)';
        });
      });
    }
  }

  document.addEventListener('click', function (e) {
    if (wsPop && wsBtn && !wsPop.contains(e.target) && !wsBtn.contains(e.target)) wsPop.classList.remove('open');
    if (notifPop && notifBtn && !notifPop.contains(e.target) && !notifBtn.contains(e.target)) notifPop.classList.remove('open');
  });

  // --------- Command palette (⌘K) ---------
  var paletteBackdrop = document.getElementById('paletteBackdrop');
  var paletteInput = document.getElementById('paletteInput');
  var paletteResults = document.getElementById('paletteResults');
  var paletteBtn = document.getElementById('paletteBtn');
  var headerSearch = document.getElementById('headerSearch');
  var paletteSel = 0;

  var commands = [
    { id: 'context-snap', title: 'Open Context-Snap', cat: 'Navigate', keys: ['⌘','1'], icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>', run: function () { D.activate('context-snap'); } },
    { id: 'docs-scraper', title: 'Open Quick-Docs Scraper', cat: 'Navigate', keys: ['⌘','2'], icon: '<path d="M4 4h10l6 6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M14 4v6h6"/>', run: function () { D.activate('docs-scraper'); } },
    { id: 'dep-map', title: 'Open Dependency Map', cat: 'Navigate', keys: ['⌘','3'], icon: '<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7.5 7.5L11 16"/><path d="M16.5 7.5L13 16"/>', run: function () { D.activate('dep-map'); } },
    { id: 'log-tail', title: 'Open Log-Tail Filter', cat: 'Navigate', keys: ['⌘','4'], icon: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', run: function () { D.activate('log-tail'); } },
    { id: 'issue-filler', title: 'Open Issue Template Filler', cat: 'Navigate', keys: ['⌘','5'], icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>', run: function () { D.activate('issue-filler'); } },
    { id: 'settings', title: 'Open Settings', cat: 'Navigate', keys: ['⌘',','], icon: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>', run: function () { D.activate('settings'); } },
    { id: 'help', title: 'Open Help & Shortcuts', cat: 'Navigate', keys: ['?'], icon: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>', run: function () { D.activate('help'); } },
    { id: 'snapshot', title: 'Capture snapshot now', cat: 'Action', keys: ['⌘','⇧','S'], icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/>', run: function () { D.activate('context-snap'); D.toast('Snapshot captured'); } },
    { id: 'pause-tail', title: 'Pause log tail', cat: 'Action', keys: ['␣'], icon: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', run: function () { D.activate('log-tail'); D.toast('Tail paused'); } },
    { id: 'pause-agent', title: 'Pause autonomous agent', cat: 'Action', keys: ['⌘','⇧','P'], icon: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="2" height="6"/><rect x="13" y="9" width="2" height="6"/>', run: function () { D.toast('Agent paused'); } },
    { id: 'profile', title: 'Edit profile', cat: 'Action', icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', run: D.openProfile },
    { id: 'sign-out', title: 'Sign out / lock workspace', cat: 'Action', keys: ['⌘','⇧','L'], icon: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>', run: D.showLogin },
    { id: 'set-agent', title: 'Settings → Autonomous Agent', cat: 'Settings', icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2"/>', run: function () { D.activate('settings'); setTimeout(function () { D.scrollSettingsTo('s-agent'); D.setActiveRailItem('s-agent'); }, 50); } },
    { id: 'set-watchers', title: 'Settings → Watchers & Triggers', cat: 'Settings', icon: '<circle cx="12" cy="12" r="2"/><path d="M12 2a10 10 0 0 1 7.07 17.07"/>', run: function () { D.activate('settings'); setTimeout(function () { D.scrollSettingsTo('s-watchers'); D.setActiveRailItem('s-watchers'); }, 50); } },
    { id: 'set-storage', title: 'Settings → Storage & Retention', cat: 'Settings', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>', run: function () { D.activate('settings'); setTimeout(function () { D.scrollSettingsTo('s-storage'); D.setActiveRailItem('s-storage'); }, 50); } },
    { id: 'set-network', title: 'Settings → Network Isolation', cat: 'Settings', icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>', run: function () { D.activate('settings'); setTimeout(function () { D.scrollSettingsTo('s-network'); D.setActiveRailItem('s-network'); }, 50); } },
    { id: 'set-security', title: 'Settings → Local Security', cat: 'Settings', icon: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', run: function () { D.activate('settings'); setTimeout(function () { D.scrollSettingsTo('s-security'); D.setActiveRailItem('s-security'); }, 50); } },
    { id: 'set-appearance', title: 'Settings → Appearance', cat: 'Settings', icon: '<circle cx="12" cy="12" r="4"/>', run: function () { D.activate('settings'); setTimeout(function () { D.scrollSettingsTo('s-appearance'); D.setActiveRailItem('s-appearance'); }, 50); } }
  ];

  D.openPalette = function () {
    if (!paletteBackdrop) return;
    paletteBackdrop.classList.add('open');
    paletteInput.value = '';
    paletteSel = 0;
    renderPalette('');
    setTimeout(function () { paletteInput.focus(); }, 30);
  };
  D.closePalette = function () { if (paletteBackdrop) paletteBackdrop.classList.remove('open'); };

  function renderPalette(q) {
    q = (q || '').toLowerCase().trim();
    var filtered = commands.filter(function (c) {
      return !q || (c.title + ' ' + c.cat).toLowerCase().indexOf(q) !== -1;
    });
    if (paletteSel >= filtered.length) paletteSel = 0;
    if (!filtered.length) {
      paletteResults.innerHTML = '<div class="palette-empty">No commands match "' + D.escapeHtml(q) + '"</div>';
      return;
    }
    paletteResults.innerHTML = filtered.map(function (c, i) {
      var keys = (c.keys || []).map(function (k) { return '<span class="kbd-pill">' + k + '</span>'; }).join('');
      return '<button class="palette-item' + (i === paletteSel ? ' active' : '') + '" data-cmd="' + c.id + '">' +
        '<div class="pi-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + c.icon + '</svg></div>' +
        '<div class="pi-meta"><div class="pi-title">' + c.title + '</div><div class="pi-cat">' + c.cat + '</div></div>' +
        (keys ? '<div class="pi-keys">' + keys + '</div>' : '') +
        '</button>';
    }).join('');
    paletteResults.querySelectorAll('.palette-item').forEach(function (el, i) {
      el.addEventListener('click', function () {
        var cmd = filtered[i];
        if (cmd) { D.closePalette(); cmd.run(); }
      });
      el.addEventListener('mousemove', function () {
        paletteResults.querySelectorAll('.palette-item').forEach(function (x) { x.classList.remove('active'); });
        el.classList.add('active');
        paletteSel = i;
      });
    });
  }

  function updatePaletteSelection() {
    var items = paletteResults.querySelectorAll('.palette-item');
    items.forEach(function (it, i) { it.classList.toggle('active', i === paletteSel); });
    var sel = items[paletteSel];
    if (!sel) return;
    var top = sel.offsetTop - paletteResults.offsetTop;
    var bottom = top + sel.offsetHeight;
    if (top < paletteResults.scrollTop) paletteResults.scrollTop = top;
    else if (bottom > paletteResults.scrollTop + paletteResults.clientHeight) {
      paletteResults.scrollTop = bottom - paletteResults.clientHeight;
    }
  }

  if (paletteInput) {
    paletteInput.addEventListener('input', function () { renderPalette(paletteInput.value); });
    paletteInput.addEventListener('keydown', function (e) {
      var items = paletteResults.querySelectorAll('.palette-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        paletteSel = (paletteSel + 1) % items.length;
        updatePaletteSelection();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        paletteSel = (paletteSel - 1 + items.length) % items.length;
        updatePaletteSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[paletteSel]) items[paletteSel].click();
      }
    });
  }
  if (paletteBackdrop) {
    paletteBackdrop.addEventListener('click', function (e) {
      if (e.target === paletteBackdrop) D.closePalette();
    });
  }
  if (paletteBtn) paletteBtn.addEventListener('click', D.openPalette);
  if (headerSearch) headerSearch.addEventListener('click', D.openPalette);

  // --------- Global keyboard shortcuts ---------
  document.addEventListener('keydown', function (e) {
    // ⌘1..5 → tool views
    if ((e.metaKey || e.ctrlKey) && /^[1-5]$/.test(e.key)) {
      e.preventDefault();
      var order = ['context-snap', 'docs-scraper', 'dep-map', 'log-tail', 'issue-filler'];
      D.activate(order[parseInt(e.key, 10) - 1]);
      return;
    }
    if (e.key === 'Escape') {
      if (profileModal && profileModal.classList.contains('open')) D.closeProfile();
      if (paletteBackdrop && paletteBackdrop.classList.contains('open')) D.closePalette();
      D.closeAllPopovers();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); D.activate('settings'); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); D.openPalette(); }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); D.showLogin(); }
    if (e.key === '?' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault(); D.activate('help');
    }
  });

  // --------- Keyboard settings panel hooks ---------
  var keyboardCard = document.getElementById('s-keyboard');
  if (keyboardCard) {
    var leaderSeg = keyboardCard.querySelector('.seg');
    if (leaderSeg) {
      leaderSeg.querySelectorAll('.seg-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          D.toast('Leader key set to ' + b.textContent.trim());
        });
      });
    }
    var enableSwitch = keyboardCard.querySelector('input[type="checkbox"]');
    if (enableSwitch) {
      enableSwitch.addEventListener('change', function () {
        D.state.shortcutsEnabled = enableSwitch.checked;
        D.toast('Shortcuts ' + (enableSwitch.checked ? 'enabled' : 'disabled'));
      });
    }
  }
})();
