function inlineFieldReportingApiUrl({ types }, { apiBaseUrl }) {
  return {
    visitor: {
      MemberExpression(path) {
        const { node } = path;
        if (
          node.computed ||
          node.property.type !== 'Identifier' ||
          node.property.name !== 'FIELD_REPORTING_API_BASE_URL' ||
          node.object.type !== 'MemberExpression' ||
          node.object.computed ||
          node.object.property.type !== 'Identifier' ||
          node.object.property.name !== 'env' ||
          node.object.object.type !== 'Identifier' ||
          node.object.object.name !== 'process'
        ) {
          return;
        }
        path.replaceWith(
          types.stringLiteral(apiBaseUrl),
        );
      },
    },
  };
}

module.exports = {
  presets: [
    'module:@react-native/babel-preset',
    '@babel/preset-typescript',
  ],
  plugins: [
    [
      inlineFieldReportingApiUrl,
      {
        apiBaseUrl: process.env.FIELD_REPORTING_API_BASE_URL ?? '',
      },
    ],
  ],
};
