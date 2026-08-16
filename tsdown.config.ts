import { defineConfig } from 'tsdown'

const id = 'dsh-memory-porter'

/**
 * 两个构建面（形状与 dsh-whale-meter 一致，那条链路已在真实 dsh 上验证过）：
 * 1. host 侧 Node 库（lib/index.js，ESM）—— dsh Loader 加载的插件本体
 * 2. 浏览器 client 包（lib/client.js，闭包工厂形态）—— 由 dsh Web 的
 *    ClientModuleRegistry 扫描 dsh.client 声明后经 /plugins/<id>/client.js 下发，
 *    通过 window.__ModuleLoader__.load 注册，externals 由宿主模块表解析。
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: true,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: false,
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
    ],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
