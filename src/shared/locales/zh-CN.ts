// 主进程与渲染进程共用的文案资源
export const zhCN = {
  common: {
    appName: 'Synote',
    openVault: '打开笔记库…',
    recentVaults: '最近打开',
    noVault: '还没有打开笔记库',
    newNote: '新建笔记',
    untitled: '未命名',
    trash: '移到回收站',
    files: '文件',
    unsaved: '未保存',
    close: '关闭',
    emptyEditor: '从左侧选择一篇笔记',
    vaultMissing: '笔记库不存在：{{path}}',
    saveFailed: '保存失败：{{message}}',
    quickOpen: '快速切换',
    commandPalette: '命令面板',
    save: '保存',
    findFile: '按名称查找文件',
    findCommand: '输入命令名称',
    noMatches: '没有匹配项',
  },
} as const
