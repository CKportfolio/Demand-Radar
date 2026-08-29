class ApifyAdDetailsProvider {
  constructor(config = {}) {
    this.config = {
      actorId: config.actorId || 'curious_coder/facebook-ads-library-scraper',
      providerName: 'APIFY_FACEBOOK_ADS_LIBRARY_SCRAPER',
    };
  }

  getCapabilities() {
    return {
      provider: this.config.providerName,
      actorId: this.config.actorId,
      canFetchByAdArchiveIds: false,
      reason: 'Current actor integration accepts only URL batches and has no documented selective ad_archive_id details input in this repo integration.',
    };
  }

  async fetchDetailsForProjectAds() {
    const error = new Error(
      'Selective details enrichment for preserved ads is not supported by the current actor integration. Adapter prepared; provider method intentionally blocked until a capable endpoint/input is available.',
    );
    error.code = 'DETAILS_PROVIDER_UNSUPPORTED';
    throw error;
  }
}

function createAdDetailsProvider(config) {
  return new ApifyAdDetailsProvider(config);
}

module.exports = {
  createAdDetailsProvider,
};
