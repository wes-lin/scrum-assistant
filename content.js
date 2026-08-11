(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    gitlabBaseUrl: '',
    zentaoBaseUrl: '',
    taskPattern: '(?:任务|task)[\\s#:/-]*(\\d+)',
    bugPattern: '(?:缺陷|bug)[\\s#:/-]*(\\d+)',
    taskUrlTemplate: '/zentao/task-view-{id}.html',
    bugUrlTemplate: '/zentao/bug-view-{id}.html',
    branchTypes: [
      { value: 'feature', label: 'Feature' },
      { value: 'release', label: 'Release' },
      { value: 'hotfix', label: 'Hotfix' }
    ]
  };

  let activeSettings = null;
  let gitlabLinkifier = null;
  let zentaoBranchEnhancer = null;

  function mergeSettings(raw) {
    const value = raw || {};
    const branchTypes = Array.isArray(value.branchTypes)
      ? value.branchTypes
          .filter((item) => item && String(item.value || '').trim() && String(item.label || '').trim())
          .map((item) => ({
            value: String(item.value).trim(),
            label: String(item.label).trim()
          }))
      : DEFAULT_SETTINGS.branchTypes;

    return {
      ...DEFAULT_SETTINGS,
      ...value,
      gitlabBaseUrl: String(value.gitlabBaseUrl || '').trim(),
      zentaoBaseUrl: String(value.zentaoBaseUrl || '').trim(),
      branchTypes
    };
  }

  function getUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
      return url;
    } catch (_error) {
      return null;
    }
  }

  function isOnConfiguredSite(baseUrl) {
    const configured = getUrl(baseUrl);
    if (!configured) {
      return false;
    }

    const configuredPath = configured.pathname.replace(/\/+$/, '');
    const matches = (candidate) => {
      if (!candidate || candidate.origin !== configured.origin) {
        return false;
      }
      if (!configuredPath || configuredPath === '/') {
        return true;
      }
      return candidate.pathname === configuredPath ||
        candidate.pathname.startsWith(`${configuredPath}/`);
    };

    if (matches(window.location)) {
      return true;
    }

    // about:blank frames inherit the parent origin but expose a null
    // location origin. Use the referrer or same-origin top frame as the
    // configured-site signal.
    if (window.location.protocol === 'about:' || window.location.origin === 'null') {
      try {
        if (document.referrer && matches(new URL(document.referrer))) {
          return true;
        }
      } catch (_error) {
        // Ignore inaccessible or malformed frame referrers.
      }
      try {
        if (window.top !== window && matches(new URL(window.top.location.href))) {
          return true;
        }
      } catch (_error) {
        // Ignore cross-origin top frames.
      }
    }
    return false;
  }

  function makeZenTaoUrl(baseUrl, template, id) {
    const base = getUrl(baseUrl);
    if (!base) {
      return '#';
    }

    const value = String(template || '').replaceAll('{id}', encodeURIComponent(String(id)));
    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    const basePath = base.pathname.replace(/\/+$/, '');
    if (value.startsWith('?')) {
      return `${base.origin}${basePath || '/'}${value}`;
    }

    const relativePath = value.startsWith('/') ? value : `/${value}`;
    return `${base.origin}${basePath}${relativePath}`;
  }

  function isIgnoredTextNode(node) {
    let element = node.parentElement;
    while (element) {
      const tagName = element.tagName;
      if (['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tagName)) {
        return true;
      }
      if (element.isContentEditable) {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  function collectMatches(text, settings) {
    const rules = [
      { type: 'task', pattern: settings.taskPattern, template: settings.taskUrlTemplate },
      { type: 'bug', pattern: settings.bugPattern, template: settings.bugUrlTemplate }
    ];
    const matches = [];

    rules.forEach((rule) => {
      if (!rule.pattern) {
        return;
      }

      let regex;
      try {
        regex = new RegExp(rule.pattern, 'gi');
      } catch (_error) {
        return;
      }

      let match;
      while ((match = regex.exec(text)) !== null) {
        if (match[1]) {
          matches.push({
            start: match.index,
            end: match.index + match[0].length,
            id: match[1],
            type: rule.type,
            template: rule.template
          });
        }
        if (match[0].length === 0) {
          regex.lastIndex += 1;
        }
      }
    });

    matches.sort((left, right) => left.start - right.start || right.end - left.end);
    const selected = [];
    let end = -1;
    matches.forEach((match) => {
      if (match.start >= end) {
        selected.push(match);
        end = match.end;
      }
    });
    return selected;
  }

  class GitLabLinkifier {
    constructor(settings) {
      this.settings = settings;
      this.observer = null;
      this.timer = null;
      this.splitAnchors = [];
    }

    start() {
      if (!isOnConfiguredSite(this.settings.gitlabBaseUrl)) {
        return;
      }

      this.process(document.body);
      this.observer = new MutationObserver((mutations) => {
        const roots = [];
        mutations.forEach((mutation) => {
          roots.push(...Array.from(mutation.addedNodes));
          const target = mutation.target.nodeType === Node.TEXT_NODE
            ? mutation.target.parentElement
            : mutation.target;
          const containingAnchor = target?.closest?.('a');
          if (containingAnchor) {
            containingAnchor.removeAttribute('data-zentao-link-processed');
            roots.push(containingAnchor);
          }
        });
        if (roots.length > 0) {
          this.schedule(Array.from(new Set(roots)));
        }
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    schedule(nodes) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => nodes.forEach((node) => this.process(node)), 80);
    }

    process(root) {
      if (!root || !document.body) {
        return;
      }

      if (root.nodeType === Node.TEXT_NODE) {
        if (!isIgnoredTextNode(root)) {
          this.linkifyTextNode(root);
        }
        return;
      }

      this.processExistingAnchors(root);

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node.nodeValue || !node.nodeValue.trim() || isIgnoredTextNode(node)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const textNodes = [];
      let current;
      while ((current = walker.nextNode())) {
        textNodes.push(current);
      }
      textNodes.forEach((node) => this.linkifyTextNode(node));
    }

    processExistingAnchors(root) {
      const anchors = [];
      if (root.nodeType === Node.ELEMENT_NODE && root.matches('a:not([data-zentao-link])')) {
        anchors.push(root);
      }
      if (root.querySelectorAll) {
        anchors.push(...Array.from(root.querySelectorAll('a:not([data-zentao-link])')));
      }
      anchors
        .filter((anchor) => !anchor.hasAttribute('data-zentao-link-processed'))
        .forEach((anchor) => this.linkifyExistingAnchor(anchor));
    }

    createZenTaoLink(match, label, isCompanion) {
      const link = document.createElement('a');
      link.href = makeZenTaoUrl(this.settings.zentaoBaseUrl, match.template, match.id);
      link.textContent = label;
      link.title = `在禅道打开${match.type === 'task' ? '任务' : '缺陷'} ${match.id}`;
      link.className = 'zentao-reference-link';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.dataset.zentaoLink = match.type;
      if (isCompanion) {
        link.dataset.zentaoLinkCompanion = 'true';
      }
      return link;
    }

    linkifyExistingAnchor(anchor) {
      const text = anchor.textContent || '';
      const matches = collectMatches(text, this.settings);
      if (matches.length === 0) {
        return;
      }

      const isPlainTextAnchor = anchor.childNodes.length === 1 &&
        anchor.firstChild.nodeType === Node.TEXT_NODE;

      // A plain-text GitLab link can be split at any position. Keep every
      // non-reference segment as a GitLab link and make each reference a
      // ZenTao link, without creating invalid nested anchors.
      const nonReferenceText = matches.reduce((remaining, match, index) => {
        const previousEnd = index === 0 ? 0 : matches[index - 1].end;
        return remaining + text.slice(previousEnd, match.start);
      }, '') + text.slice(matches[matches.length - 1].end);
      if (isPlainTextAnchor && nonReferenceText.trim()) {
        const wrapper = document.createElement('span');
        wrapper.dataset.zentaoAnchorSplit = 'true';
        let cursor = 0;
        matches.forEach((match) => {
          if (match.start > cursor) {
            const gitlabLink = anchor.cloneNode(false);
            gitlabLink.textContent = text.slice(cursor, match.start);
            wrapper.appendChild(gitlabLink);
          }
          wrapper.appendChild(this.createZenTaoLink(
            match,
            text.slice(match.start, match.end)
          ));
          cursor = match.end;
        });
        if (cursor < text.length) {
          const gitlabLink = anchor.cloneNode(false);
          gitlabLink.textContent = text.slice(cursor);
          wrapper.appendChild(gitlabLink);
        }
        this.splitAnchors.push({ wrapper, original: anchor.cloneNode(true) });
        anchor.replaceWith(wrapper);
        return;
      }

      // Nested anchors are invalid HTML. For complex anchors, keep GitLab's
      // link intact and add an explicit ZenTao entry beside it.
      anchor.setAttribute('data-zentao-link-processed', 'true');
      const companionFragment = document.createDocumentFragment();
      matches.forEach((match) => {
        companionFragment.appendChild(document.createTextNode(' '));
        companionFragment.appendChild(this.createZenTaoLink(
          match,
          `禅道${match.type === 'task' ? '任务' : '缺陷'} ${match.id}`,
          true
        ));
      });
      anchor.after(companionFragment);
    }

    linkifyTextNode(node) {
      const text = node.nodeValue;
      const matches = collectMatches(text, this.settings);
      if (matches.length === 0) {
        return;
      }

      const fragment = document.createDocumentFragment();
      let cursor = 0;
      matches.forEach((match) => {
        if (match.start > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
        }

        fragment.appendChild(this.createZenTaoLink(
          match,
          text.slice(match.start, match.end)
        ));
        cursor = match.end;
      });
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      node.replaceWith(fragment);
    }

    stop() {
      if (this.observer) {
        this.observer.disconnect();
      }
      clearTimeout(this.timer);
      this.splitAnchors.forEach(({ wrapper, original }) => {
        if (wrapper.isConnected) {
          wrapper.replaceWith(original);
        }
      });
      this.splitAnchors = [];
      document.querySelectorAll('a[data-zentao-link-companion]').forEach((link) => {
        const spacer = link.previousSibling;
        if (spacer?.nodeType === Node.TEXT_NODE && spacer.nodeValue === ' ') {
          spacer.remove();
        }
        link.remove();
      });
      document.querySelectorAll('a[data-zentao-link]').forEach((link) => {
        link.replaceWith(document.createTextNode(link.textContent || ''));
      });
      document.querySelectorAll('[data-zentao-link-processed]').forEach((anchor) => {
        anchor.removeAttribute('data-zentao-link-processed');
      });
    }
  }

  function isBranchCreationContext() {
    const currentUrl = window.location.href.toLowerCase();
    if (/branch|分支/.test(currentUrl)) {
      return true;
    }

    const pageText = (document.body?.innerText || '').slice(0, 30000).toLowerCase();
    return /(?:创建|新建|create|add).{0,20}(?:分支|branch)/i.test(pageText) ||
      /(?:分支|branch).{0,20}(?:创建|新建|create|add)/i.test(pageText);
  }

  function selectLooksLikeBranchType(select) {
    const key = `${select.id} ${select.name} ${select.className}`.toLowerCase();
    if (/branch.?type|type.?branch|分支.*类型|类型.*分支/.test(key)) {
      return true;
    }

    const context = select.closest('tr, .form-group, .form-item, .field, .form-row, .control-group, .input-group, form, body');
    const contextText = (context?.innerText || '').slice(0, 1000);
    return /分支.{0,12}(类型|type)|(类型|type).{0,12}分支/i.test(contextText);
  }

  class ZenTaoBranchEnhancer {
    constructor(settings) {
      this.settings = settings;
      this.observer = null;
      this.timer = null;
    }

    start() {
      if (!isOnConfiguredSite(this.settings.zentaoBaseUrl)) {
        return;
      }

      this.enhance();
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.enhance(), 100);
    }

    enhance() {
      const branchNameInputs = Array.from(document.querySelectorAll(
        'input[name="branchName"], input#branchName, input[id*="branchName" i], input[name*="branchName" i]'
      ));
      if (branchNameInputs.length === 0 && !isBranchCreationContext()) {
        return;
      }

      branchNameInputs.forEach((input) => this.enhanceBranchNameInput(input));

      const selects = Array.from(document.querySelectorAll('select'));
      const branchTypeSelects = selects.filter((select) => {
        if (select.hasAttribute('data-zentao-branch-type-selector')) {
          return false;
        }
        if (selectLooksLikeBranchType(select)) {
          return true;
        }
        const key = `${select.id} ${select.name}`.toLowerCase();
        return /type|类型/.test(key) && /branch|分支/.test(window.location.href.toLowerCase());
      });

      branchTypeSelects.forEach((select) => {
        const hasEmptyOption = Array.from(select.options).some((option) => option.value === '');
        if (!hasEmptyOption) {
          const emptyOption = document.createElement('option');
          emptyOption.value = '';
          emptyOption.textContent = '不创建类型';
          emptyOption.dataset.zentaoBranchTypeOption = 'true';
          select.appendChild(emptyOption);
        }
        this.settings.branchTypes.forEach((branchType) => {
          const alreadyExists = Array.from(select.options).some((option) =>
            option.value === branchType.value || option.textContent.trim() === branchType.label
          );
          if (!alreadyExists) {
            const option = document.createElement('option');
            option.value = branchType.value;
            option.textContent = branchType.label;
            option.dataset.zentaoBranchTypeOption = 'true';
            select.appendChild(option);
          }
        });
      });
    }

    formatBranchName(type, name) {
      return `${type}/${name}`;
    }

    enhanceBranchNameInput(input) {
      if (input.hasAttribute('data-zentao-branch-name-enhanced')) {
        return;
      }

      const formGroup = input.closest('.form-group, .form-item, .field, .form-row') || input.parentElement;
      if (!formGroup || !formGroup.parentElement) {
        return;
      }

      const select = document.createElement('select');
      select.className = input.className || 'form-control';
      select.dataset.zentaoBranchTypeSelector = 'true';
      select.id = `zentao-branch-type-${Math.random().toString(36).slice(2, 9)}`;
      select.style.flex = '0 0 130px';
      select.style.minWidth = '110px';

      this.settings.branchTypes.forEach((branchType) => {
        const option = document.createElement('option');
        option.value = branchType.value;
        option.textContent = branchType.label;
        select.appendChild(option);
      });
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = '不创建类型';
      select.appendChild(emptyOption);

      const controlRow = document.createElement('div');
      controlRow.dataset.zentaoBranchControlRow = 'true';
      controlRow.style.display = 'flex';
      controlRow.style.alignItems = 'center';
      controlRow.style.gap = '8px';
      controlRow.style.flex = '1 1 auto';
      controlRow.style.minWidth = '0';
      input.style.flex = '1 1 auto';
      input.style.minWidth = '0';
      input.parentElement.insertBefore(controlRow, input);
      controlRow.append(select, input);

      const currentName = input.value.trim();
      const existingType = this.settings.branchTypes.find((branchType) =>
        currentName.startsWith(`${branchType.value}/`)
      );
      const baseName = existingType
        ? currentName.slice(existingType.value.length + 1)
        : currentName;
      const defaultType = existingType || this.settings.branchTypes[0];
      select.value = defaultType ? defaultType.value : '';
      input.dataset.zentaoBranchBaseName = baseName;
      input.dataset.zentaoBranchNameEnhanced = 'true';

      let lastGeneratedName = currentName;
      const applyType = () => {
        const selectedType = this.settings.branchTypes.find((item) => item.value === select.value);
        const baseName = input.dataset.zentaoBranchBaseName || '';
        const name = selectedType
          ? this.formatBranchName(selectedType.value, baseName)
          : baseName;
        input.dataset.zentaoBranchUpdating = 'true';
        input.value = name;
        input.dataset.zentaoBranchUpdating = 'false';
        lastGeneratedName = name;
      };

      input.addEventListener('input', () => {
        if (input.dataset.zentaoBranchUpdating !== 'true' && input.value !== lastGeneratedName) {
          const selectedType = this.settings.branchTypes.find((item) => item.value === select.value);
          const generatedPrefix = selectedType
            ? this.formatBranchName(selectedType.value, '')
            : '';
          input.dataset.zentaoBranchBaseName = generatedPrefix && input.value.startsWith(generatedPrefix)
            ? input.value.slice(generatedPrefix.length)
            : input.value;
          lastGeneratedName = input.value;
        }
      });
      select.addEventListener('change', applyType);
      applyType();
    }

    stop() {
      if (this.observer) {
        this.observer.disconnect();
      }
      clearTimeout(this.timer);
      document.querySelectorAll('option[data-zentao-branch-type-option]').forEach((option) => option.remove());
      document.querySelectorAll('input[data-zentao-branch-name-enhanced]').forEach((input) => {
        if (input.dataset.zentaoBranchBaseName !== undefined) {
          input.value = input.dataset.zentaoBranchBaseName;
        }
        delete input.dataset.zentaoBranchBaseName;
        delete input.dataset.zentaoBranchNameEnhanced;
        delete input.dataset.zentaoBranchUpdating;
      });
      document.querySelectorAll('[data-zentao-branch-control-row]').forEach((row) => {
        const input = row.querySelector('input');
        if (input) {
          input.style.removeProperty('flex');
          input.style.removeProperty('min-width');
          row.parentElement.insertBefore(input, row);
        }
        row.remove();
      });
    }
  }

  function addLinkStyles() {
    if (document.getElementById('zentao-reference-link-style')) {
      return;
    }
    const style = document.createElement('style');
    style.id = 'zentao-reference-link-style';
    style.textContent = `
      a.zentao-reference-link {
        color: #1769aa;
        text-decoration: underline;
        text-decoration-style: dotted;
        text-underline-offset: 2px;
      }
      a.zentao-reference-link:hover {
        color: #0b4f80;
        text-decoration-style: solid;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function applySettings(rawSettings) {
    activeSettings = mergeSettings(rawSettings);
    if (gitlabLinkifier) {
      gitlabLinkifier.stop();
      gitlabLinkifier = null;
    }
    if (zentaoBranchEnhancer) {
      zentaoBranchEnhancer.stop();
      zentaoBranchEnhancer = null;
    }

    if (activeSettings.gitlabBaseUrl && activeSettings.zentaoBaseUrl) {
      addLinkStyles();
      gitlabLinkifier = new GitLabLinkifier(activeSettings);
      gitlabLinkifier.start();
    }

    if (activeSettings.zentaoBaseUrl) {
      zentaoBranchEnhancer = new ZenTaoBranchEnhancer(activeSettings);
      zentaoBranchEnhancer.start();
    }
  }

  chrome.storage.local.get(DEFAULT_SETTINGS, applySettings);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }
    const nextSettings = { ...(activeSettings || DEFAULT_SETTINGS) };
    Object.keys(changes).forEach((key) => {
      nextSettings[key] = changes[key].newValue;
    });
    applySettings(nextSettings);
  });
})();
