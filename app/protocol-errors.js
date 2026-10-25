class UnsupportedProtocolFeatureError extends Error {
  constructor(message, code = 'unsupported_protocol_feature') {
    super(message);
    this.name = 'UnsupportedProtocolFeatureError';
    this.code = code;
  }
}
module.exports = { UnsupportedProtocolFeatureError };
