(function () {
  'use strict';
  const status = document.getElementById('configuration-status');
  chrome.storage.local.get(['gitlabBaseUrl', 'zentaoBaseUrl'], (settings) => {
    if (settings.gitlabBaseUrl && settings.zentaoBaseUrl) {
      status.textContent = '已配置 GitLab 和禅道地址。';
      status.classList.add('ready');
    } else {
      status.textContent = '还没有完成地址配置。';
    }
  });
  document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
})();
