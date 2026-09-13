/**
 * The site's translated strings, one object per locale. Facts live here once
 * (the privacy claims, the platform list) and are worded to match the shipped
 * behaviour: telemetry is local-only and consent-gated, the GPL is named, and
 * the macOS unsigned caveat is stated rather than hidden — the site must not
 * promise more than the installer does.
 */

export const ZH = {
  title: 'GoMentor',
  tagline: '围棋 AI 学习平台',
  description:
    'KataGo 实时分析 + AI 教师对话 + 学生弱项画像：本地优先的围棋学习桌面应用。',
  nav: { download: '下载', docs: '文档', privacy: '隐私' },
  hero: {
    headline: '打谱、复盘、被指点——都在一个本地应用里',
    sub: 'KataGo 引擎实时分析每一手；AI 教师引用真实数据回答你的问题；棋库与分析结果落在本机 SQLite,弱项画像由纯规则推导——不联网也能完整使用。',
    cta: '前往下载',
  },
  features: [
    {
      title: 'KataGo 实时分析',
      body: '胜率、选点、PV 变化图、全谱胜率曲线。内置 CPU 引擎开箱即用,CUDA/OpenCL 可选加速。',
    },
    {
      title: 'AI 教师对话',
      body: '教师经只读工具引用引擎与棋库的真实数字——只解释,不编造。',
    },
    {
      title: '学生弱项画像',
      body: '批量分析整库棋谱,由分析增量纯规则推导三大弱项,每条弱项附证据链接直达对应一手。',
    },
    {
      title: '本地优先',
      body: '棋库、分析、画像全部存于本机;遥测默认关闭且仅存本地,绝无内容上传。',
    },
    {
      title: '野狐棋谱同步',
      body: '输入野狐昵称即可浏览并导入公开对局,自动进入棋库与画像管线。',
    },
    {
      title: '中英双语',
      body: '界面与文档完整支持中文和英文。',
    },
  ],
  download: {
    headline: '下载 GoMentor',
    platforms: [
      { os: 'Windows 10/11 (x64)', note: '安装包内含 CPU 引擎,安装即可用。' },
      {
        os: 'macOS (Apple Silicon)',
        note: '未签名构建:首次启动需右键打开或在系统设置中放行。',
      },
      { os: 'Linux (x64)', note: 'AppImage 格式。' },
    ],
    button: '前往 GitHub Releases 下载',
    note: '所有安装包均发布在 GitHub Releases;自动更新同样经由 Releases 分发。',
  },
  docs: {
    headline: '快速上手',
    steps: [
      '下载并安装对应平台的安装包(见下载页)。',
      '把 SGF 棋谱拖进棋谱库;打开一局,KataGo 立即开始分析。',
      '在设置里配置 AI 教师的语言模型(云端 API 或本地服务器)。',
      '运行"分析我的棋库",让画像从真实对局中长出来。',
    ],
    telemetryTitle: '隐私与遥测',
    telemetryBody:
      '遥测默认关闭。开启后仅在本机记录崩溃转储与少量匿名事件(版本号等标量信息),永不上传,也绝不含棋谱、对话或任何输入内容。可随时从帮助菜单查看收集了什么。',
    licenseTitle: '许可',
    licenseBody:
      'GoMentor 以 GPL-3.0 发布;内置的 KataGo(MIT)与权重(CC0)在其自带许可下分发,详见仓库 NOTICE。',
  },
  privacy: {
    headline: '隐私',
    intro: 'GoMentor 是本地优先的应用:你的棋谱、分析与画像默认只存在于你的电脑上。',
    sections: [
      {
        title: '遥测(默认关闭)',
        body: '开启 consent 后,崩溃转储与少量匿名事件(应用版本、引擎启动等标量字段)写入本机目录;没有任何网络传输。事件结构是封闭的类型联合——不存在能装下棋谱或对话的字段。',
      },
      {
        title: '语言模型',
        body: '配置了云端 API 时,教师对话会按你填写的服务地址调用该 API;配置本地服务器时,对话不出本机。密钥经操作系统凭据库加密存储。',
      },
      {
        title: '自动更新',
        body: '向 GitHub Releases 查询版本信息;安装包本身不携带任何遥测。',
      },
    ],
  },
  footer: 'GoMentor — GPL-3.0;KataGo 与权重见仓库 NOTICE。',
} as const

export const EN: typeof ZH = {
  title: 'GoMentor',
  tagline: 'A local-first Go study platform',
  description:
    'Live KataGo analysis, an AI teacher that cites real data, and a derived weakness profile — a desktop app for Go study.',
  nav: { download: 'Download', docs: 'Docs', privacy: 'Privacy' },
  hero: {
    headline: 'Study, review, get coached — in one local app',
    sub: 'KataGo analyses every move as you play through a record; the AI teacher answers with real numbers from the engine and your library; games, analysis rows, and the derived weakness profile live in a local SQLite database. Fully usable offline.',
    cta: 'Get GoMentor',
  },
  features: [
    {
      title: 'Live KataGo analysis',
      body: 'Winrate, candidates, principal variations, and a whole-record winrate graph. The bundled CPU engine works out of the box; CUDA/OpenCL are optional.',
    },
    {
      title: 'An AI teacher',
      body: 'The teacher consults read-only tools and quotes the engine and the library — it explains real numbers instead of inventing them.',
    },
    {
      title: 'A weakness profile',
      body: 'Batch-analyse the whole library; pure rules derive three named weaknesses, each with evidence that opens the game at the exact move.',
    },
    {
      title: 'Local first',
      body: 'Library, analysis, and profile live on your machine. Telemetry is off by default and local-only when enabled — nothing is uploaded.',
    },
    {
      title: 'Fox game sync',
      body: 'Enter a Fox (野狐) nickname to browse and import public games straight into the library and the profile pipeline.',
    },
    {
      title: 'English & Chinese',
      body: 'The interface and documentation ship in both English and Chinese.',
    },
  ],
  download: {
    headline: 'Download GoMentor',
    platforms: [
      {
        os: 'Windows 10/11 (x64)',
        note: 'The installer bundles the CPU engine — install and analyse.',
      },
      {
        os: 'macOS (Apple Silicon)',
        note: 'Unsigned build: right-click to open on first launch, or allow it in System Settings.',
      },
      { os: 'Linux (x64)', note: 'AppImage.' },
    ],
    button: 'Download from GitHub Releases',
    note: 'Every installer is published on GitHub Releases; auto-update draws from the same releases.',
  },
  docs: {
    headline: 'Getting started',
    steps: [
      'Download and run the installer for your platform (see Download).',
      'Drag SGF records into the library; open one and KataGo starts analysing immediately.',
      'Configure the AI teacher in Settings (a cloud API or a local server).',
      'Run "analyse my library" and let the profile grow out of real games.',
    ],
    telemetryTitle: 'Privacy and telemetry',
    telemetryBody:
      'Telemetry is off by default. When consented, crash dumps and a few anonymous events (version numbers and other scalar fields) are written to a local directory — never uploaded, and never containing games, chats, or anything you type. See what was collected any time from the Help menu.',
    licenseTitle: 'Licence',
    licenseBody:
      'GoMentor is GPL-3.0. The bundled KataGo (MIT) and weights (CC0) ship under their own licences — see the repository NOTICE.',
  },
  privacy: {
    headline: 'Privacy',
    intro:
      'GoMentor is local-first: your games, analysis, and profile exist on your computer unless you move them.',
    sections: [
      {
        title: 'Telemetry (off by default)',
        body: 'With consent, crash dumps and a few anonymous events (app version and other scalar fields) are written to a local directory; no network transfer exists. The event structure is a closed typed union — there is no field that could hold a game record or a chat message.',
      },
      {
        title: 'Language models',
        body: 'With a cloud API configured, teacher conversations call that API at the address you provide; with a local server, nothing leaves the machine. Keys are encrypted by the OS credential store.',
      },
      {
        title: 'Auto-update',
        body: 'Queries GitHub Releases for version information; the installer itself carries no telemetry.',
      },
    ],
  },
  footer: 'GoMentor — GPL-3.0; KataGo and weights: see the repository NOTICE.',
} as const
