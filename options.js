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

  const form = document.getElementById('settings-form');
  const branchTypesContainer = document.getElementById('branch-types');
  const status = document.getElementById('save-status');

  function mergeSettings(raw) {
    const value = raw || {};
    return {
      ...DEFAULT_SETTINGS,
      ...value,
      branchTypes: Array.isArray(value.branchTypes) ? value.branchTypes : DEFAULT_SETTINGS.branchTypes
    };
  }

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle('error', Boolean(isError));
  }

  function addBranchRow(branchType = { value: '', label: '' }) {
    const row = document.createElement('div');
    row.className = 'branch-row';
    row.innerHTML = `
      <input type="text" data-branch-value placeholder="提交值，如 feature" value="${escapeAttribute(branchType.value)}" aria-label="分支类型提交值">
      <input type="text" data-branch-label placeholder="显示名称，如 Feature" value="${escapeAttribute(branchType.label)}" aria-label="分支类型显示名称">
      <button type="button" data-remove-branch aria-label="删除此分支类型">×</button>
    `;
    row.querySelector('[data-remove-branch]').addEventListener('click', () => row.remove());
    branchTypesContainer.appendChild(row);
  }

  function escapeAttribute(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function render(settings) {
    ['gitlabBaseUrl', 'zentaoBaseUrl', 'taskPattern', 'bugPattern', 'taskUrlTemplate', 'bugUrlTemplate']
      .forEach((id) => { document.getElementById(id).value = settings[id] || ''; });
    branchTypesContainer.replaceChildren();
    settings.branchTypes.forEach(addBranchRow);
  }

  function readBranchTypes() {
    const seenValues = new Set();
    const types = [];
    branchTypesContainer.querySelectorAll('.branch-row').forEach((row) => {
      const value = row.querySelector('[data-branch-value]').value.trim();
      const label = row.querySelector('[data-branch-label]').value.trim();
      if (!value && !label) {
        return;
      }
      if (!value || !label) {
        throw new Error('每个分支类型都需要填写提交值和显示名称。');
      }
      if (seenValues.has(value)) {
        throw new Error(`分支类型提交值重复：${value}`);
      }
      seenValues.add(value);
      types.push({ value, label });
    });
    return types;
  }

  function validateUrl(value, label) {
    if (!value) {
      throw new Error(`请填写${label}。`);
    }
    let url;
    try {
      url = new URL(value);
    } catch (_error) {
      throw new Error(`${label}不是有效的 URL。`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`${label}必须使用 http 或 https。`);
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  function validatePattern(value, label) {
    if (!value) {
      throw new Error(`请填写${label}。`);
    }
    try {
      new RegExp(value, 'i');
    } catch (_error) {
      throw new Error(`${label}不是有效的 JavaScript 正则表达式。`);
    }
    if (!hasCapturingGroup(value)) {
      throw new Error(`${label}必须包含一个捕获组，并把 ID 放在第一个捕获组中。`);
    }
    return value;
  }

  function hasCapturingGroup(source) {
    let escaped = false;
    let inCharacterClass = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '[') {
        inCharacterClass = true;
        continue;
      }
      if (character === ']' && inCharacterClass) {
        inCharacterClass = false;
        continue;
      }
      if (character !== '(' || inCharacterClass) {
        continue;
      }
      if (source[index + 1] !== '?') {
        return true;
      }
      if (source.startsWith('(?<', index) &&
          !source.startsWith('(?<=', index) &&
          !source.startsWith('(?<!', index)) {
        return true;
      }
    }
    return false;
  }

  function validateTemplate(value, label) {
    if (!value.includes('{id}')) {
      throw new Error(`${label}必须包含 {id} 占位符。`);
    }
    return value;
  }

  function readSettings() {
    return {
      gitlabBaseUrl: validateUrl(document.getElementById('gitlabBaseUrl').value.trim(), 'GitLab 地址'),
      zentaoBaseUrl: validateUrl(document.getElementById('zentaoBaseUrl').value.trim(), '禅道地址'),
      taskPattern: validatePattern(document.getElementById('taskPattern').value.trim(), '任务 ID 规则'),
      bugPattern: validatePattern(document.getElementById('bugPattern').value.trim(), 'Bug ID 规则'),
      taskUrlTemplate: validateTemplate(
        document.getElementById('taskUrlTemplate').value.trim() || DEFAULT_SETTINGS.taskUrlTemplate,
        '任务链接路径模板'
      ),
      bugUrlTemplate: validateTemplate(
        document.getElementById('bugUrlTemplate').value.trim() || DEFAULT_SETTINGS.bugUrlTemplate,
        'Bug 链接路径模板'
      ),
      branchTypes: readBranchTypes()
    };
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const settings = readSettings();
      chrome.storage.local.set(settings, () => {
        if (chrome.runtime.lastError) {
          setStatus(`保存失败：${chrome.runtime.lastError.message}`, true);
          return;
        }
        setStatus('设置已保存，打开或刷新 GitLab/禅道页面后即可生效。', false);
      });
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  document.getElementById('add-branch-type').addEventListener('click', () => addBranchRow());
  document.getElementById('reset-settings').addEventListener('click', () => {
    if (window.confirm('确定恢复默认设置吗？当前配置会被覆盖。')) {
      chrome.storage.local.clear(() => {
        render(DEFAULT_SETTINGS);
        setStatus('已恢复默认设置，请点击“保存设置”使其生效。', false);
      });
    }
  });

  chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => render(mergeSettings(settings)));
})();
