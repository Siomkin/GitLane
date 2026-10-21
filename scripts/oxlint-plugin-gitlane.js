// Local oxlint JS plugin (oxlint.config.ts `jsPlugins`): the rules oxlint has
// no native equivalent for. Uses the ESLint rule API oxlint implements.
export default {
  meta: { name: "gitlane" },
  rules: {
    // Replaces ESLint's no-restricted-syntax selector: the @/ alias convention
    // also covers module paths passed to vi.mock() / vi.doMock().
    "no-parent-vi-mock": {
      create(context) {
        return {
          CallExpression(node) {
            const { callee, arguments: args } = node;
            if (
              callee.type === "MemberExpression" &&
              callee.object.name === "vi" &&
              ["mock", "doMock"].includes(callee.property.name) &&
              typeof args[0]?.value === "string" &&
              args[0].value.startsWith("../")
            ) {
              context.report({
                node: args[0],
                message: "Use the @/ alias instead of a parent-directory path in vi.mock().",
              });
            }
          },
        };
      },
    },
  },
};
