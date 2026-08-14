const path = require("path");
module.exports = {
  webpack: {
    alias: { "@": path.resolve(__dirname, "src") },
    configure: (cfg) => {
      cfg.watchOptions = {
        ...cfg.watchOptions,
        ignored: ["**/node_modules/**","**/.git/**","**/build/**","**/dist/**","**/coverage/**","**/public/**"],
      };
      return cfg;
    },
  },
  eslint: {
    configure: {
      extends: ["plugin:react-hooks/recommended"],
      rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
    },
  },
};
