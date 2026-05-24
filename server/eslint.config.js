import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'public', '**/*.test.ts']),
  {
    files: ['**/*.ts'],
    plugins: { sonarjs },
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // server 是第一次接入 ESLint 的存量代码：基线推荐集会把一批历史写法判成 error。
      // 当前定位是"雷达不当门禁"，故先整体降为 warn，确保 `npm run lint` 退出码 0；
      // 后续逐项清理后可再 ratchet 回 error。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      'no-empty': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      // ── 复杂度雷达（全部 warn，只报告不挡构建；server 构建用 tsup/tsx，不跑 eslint）──
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
    },
  },
])
