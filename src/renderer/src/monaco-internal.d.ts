// diff.ts 用到的 Monaco 内部模块（包里没有类型声明），只声明用到的部分
declare module 'monaco-editor/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: { get<T>(id: unknown): T }
}
declare module 'monaco-editor/platform/keybinding/common/keybinding.js' {
  export const IKeybindingService: unknown
}
declare module 'monaco-editor/platform/commands/common/commands.js' {
  export const CommandsRegistry: { getCommand(id: string): unknown }
}
