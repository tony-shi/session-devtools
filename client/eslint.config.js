import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { sonarjs },
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
      // ── 复杂度雷达（全部 warn，只报告不挡构建；构建链路 vite/tsc 不跑 eslint）──
      // 物理尺寸：单文件 > 500 行通常是 bad smell，值得人工 review。
      'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
      'complexity': ['warn', 15],          // 圈复杂度：函数分支路径数
      'max-depth': ['warn', 4],            // 嵌套深度
      'max-params': ['warn', 5],           // 参数个数
      // 认知复杂度：嵌套加权，比圈复杂度更贴近"人读起来有多累"。
      'sonarjs/cognitive-complexity': ['warn', 15],
      // 高价值坏味道（Sonar 风味）：
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-identical-expressions': 'warn',
      'sonarjs/no-collapsible-if': 'warn',
      'sonarjs/no-redundant-boolean': 'warn',
      'sonarjs/no-all-duplicated-branches': 'warn',
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
