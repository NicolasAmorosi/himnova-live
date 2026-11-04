import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  { ignores: ["out/**", "dist/**", "release/**", "drizzle/**", ".scratch/**", "native/.build/**", "native/libmpv-mac/out/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  // Config and script files are outside the app's tsconfigs; the type-aware
  // rules have no program for them.
  { files: ["**/*.js", "**/*.mjs"], extends: [tseslint.configs.disableTypeChecked] },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    extends: [jsxA11y.flatConfigs.recommended],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Off for the whole renderer, not suppressed per site: every `<video>`
      // and `<audio>` here plays a file the operator picked off their own
      // disk seconds earlier. There is no caption track to attach and no
      // place one could come from, so the rule can only ever be noise.
      "jsx-a11y/media-has-caption": "off",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
