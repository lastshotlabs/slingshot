const logql = {
  name: 'logql',
  displayName: 'LogQL',
  scopeName: 'source.logql',
  patterns: [
    { include: '#comments' },
    { include: '#strings' },
    { include: '#durations' },
    { include: '#numbers' },
    { include: '#rangeSelectors' },
    { include: '#labelMatchers' },
    { include: '#functions' },
    { include: '#keywords' },
    { include: '#operators' },
  ],
  repository: {
    comments: {
      patterns: [
        {
          name: 'comment.line.number-sign.logql',
          match: '#.*$',
        },
      ],
    },
    strings: {
      patterns: [
        {
          name: 'string.quoted.double.logql',
          begin: '"',
          end: '"',
          patterns: [{ match: '\\\\.', name: 'constant.character.escape.logql' }],
        },
        {
          name: 'string.quoted.single.logql',
          begin: "'",
          end: "'",
          patterns: [{ match: '\\\\.', name: 'constant.character.escape.logql' }],
        },
        {
          name: 'string.quoted.other.backtick.logql',
          begin: '`',
          end: '`',
        },
      ],
    },
    durations: {
      patterns: [
        {
          name: 'constant.numeric.duration.logql',
          match: '\\b\\d+(?:ms|s|m|h|d|w|y)\\b',
        },
      ],
    },
    numbers: {
      patterns: [
        {
          name: 'constant.numeric.logql',
          match: '\\b\\d+(?:\\.\\d+)?\\b',
        },
      ],
    },
    rangeSelectors: {
      patterns: [
        {
          name: 'meta.selector.range.logql',
          begin: '\\[',
          end: '\\]',
          patterns: [
            { include: '#durations' },
            { include: '#numbers' },
            {
              name: 'keyword.operator.offset.logql',
              match: '\\boffset\\b',
            },
          ],
        },
      ],
    },
    labelMatchers: {
      patterns: [
        {
          name: 'meta.selector.labels.logql',
          begin: '\\{',
          end: '\\}',
          patterns: [
            {
              name: 'variable.other.label.logql',
              match: '\\b[a-zA-Z_][\\w:.-]*(?=\\s*(?:!?=~?|!?~))',
            },
            {
              name: 'keyword.operator.matcher.logql',
              match: '!?=~?|!?~',
            },
            { include: '#strings' },
            { include: '#numbers' },
          ],
        },
      ],
    },
    functions: {
      patterns: [
        {
          name: 'support.function.logql',
          match:
            '\\b(?:sum|avg|min|max|count|rate|bytes_rate|bytes_over_time|count_over_time|sum_over_time|avg_over_time|min_over_time|max_over_time|quantile_over_time|stddev_over_time|stdvar_over_time|last_over_time|first_over_time|absent_over_time|topk|bottomk|sort|sort_desc|json|logfmt|regexp|pattern|unwrap|line_format|label_format|decolorize|keep|drop)\\b',
        },
      ],
    },
    keywords: {
      patterns: [
        {
          name: 'keyword.control.logql',
          match:
            '\\b(?:by|without|on|ignoring|group_left|group_right|bool|and|or|unless|offset)\\b',
        },
      ],
    },
    operators: {
      patterns: [
        {
          name: 'keyword.operator.pipeline.logql',
          match: '\\|=|\\|~|!=|!~|\\|',
        },
        {
          name: 'keyword.operator.comparison.logql',
          match: '==|>=|<=|>|<',
        },
        {
          name: 'keyword.operator.arithmetic.logql',
          match: '\\+|-|\\*|/|%',
        },
        {
          name: 'punctuation.separator.logql',
          match: '[(),]',
        },
      ],
    },
  },
};

export default logql;
