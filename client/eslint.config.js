import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // `_`-前缀的变量 / 参数 / 解构丢弃是"刻意不用"的约定（如 `const { mode: _m, ...rest }`）。
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // React-Compiler / Fast-Refresh 的"优化提示"类规则降为 warn —— 它们是开发期
      // 性能 / HMR 提示，不是正确性问题。本项目大量合法模式会触发它们：
      //   · only-export-components：shadcn ui 组件按惯例与 cva variants 同文件导出
      //   · set-state-in-effect：标准的 fetch-on-mount / URL→state 同步
      //   · static-components / purity：局部组件定义 / 渲染期读 Date.now() 的瞬时标记
      // 正确性规则（rules-of-hooks、no-unused-vars 等）保持 error。
      'react-refresh/only-export-components': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
])
