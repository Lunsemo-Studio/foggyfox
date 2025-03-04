/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  ServiceWorkerCleanUp: "resource://gre/modules/ServiceWorkerCleanUp.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "sas",
  "@mozilla.org/storage/activity-service;1",
  "nsIStorageActivityService"
);
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "TrackingDBService",
  "@mozilla.org/tracking-db-service;1",
  "nsITrackingDBService"
);
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "IdentityCredentialStorageService",
  "@mozilla.org/browser/identity-credential-storage-service;1",
  "nsIIdentityCredentialStorageService"
);
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "bounceTrackingProtection",
  "@mozilla.org/bounce-tracking-protection;1",
  "nsIBounceTrackingProtection"
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "isBounceTrackingProtectionEnabled",
  "privacy.bounceTrackingProtection.enabled",
  false
);

/**
 * Test if host, OriginAttributes or principal belong to a baseDomain. Also
 * considers partitioned storage by inspecting OriginAttributes partitionKey.
 * @param options
 * @param {string} [options.host] - Optional host to compare to base domain.
 * @param {object} [options.originAttributes] - Optional origin attributes to
 * inspect for aBaseDomain. If omitted, partitionKey will not be matched.
 * @param {nsIPrincipal} [options.principal] - Optional principal to compare to
 * base domain.
 * @param {string} aBaseDomain - Domain to check for. Must be a valid, non-empty
 * baseDomain string.
 * @returns {boolean} Whether the host, originAttributes or principal matches
 * the base domain.
 */
function hasBaseDomain(
  { host = null, originAttributes = null, principal = null },
  aBaseDomain
) {
  if (!aBaseDomain) {
    throw new Error("Missing baseDomain.");
  }
  if (!host && !originAttributes && !principal) {
    throw new Error(
      "Missing host, originAttributes or principal to match with baseDomain."
    );
  }
  if (principal && (host || originAttributes)) {
    throw new Error(
      "Can only pass either principal or host and originAttributes."
    );
  }

  if (host && Services.eTLD.hasRootDomain(host, aBaseDomain)) {
    return true;
  }

  if (principal?.baseDomain == aBaseDomain) {
    return true;
  }

  originAttributes = originAttributes || principal?.originAttributes;
  if (!originAttributes) {
    return false;
  }

  return ChromeUtils.originAttributesMatchPattern(originAttributes, {
    partitionKeyPattern: { baseDomain: aBaseDomain },
  });
}

/**
 * Compute the base domain from a given host. This is a wrapper around
 * Services.eTLD.getBaseDomainFromHost which also supports IP addresses and
 * hosts such as "localhost" which are considered valid base domains for
 * principals and data storage.
 * @param {string} aDomainOrHost - Domain or host to be converted. May already
 * be a valid base domain.
 * @returns {string} Base domain of the given host. Returns aDomainOrHost if
 * already a base domain.
 */
function getBaseDomainWithFallback(aDomainOrHost) {
  let result = aDomainOrHost;
  try {
    result = Services.eTLD.getBaseDomainFromHost(aDomainOrHost);
  } catch (e) {
    if (
      e.result == Cr.NS_ERROR_HOST_IS_IP_ADDRESS ||
      e.result == Cr.NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS
    ) {
      // For these 2 expected errors, just take the host as the result.
      // - NS_ERROR_HOST_IS_IP_ADDRESS: the host is in ipv4/ipv6.
      // - NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS: not enough domain parts to extract.
      result = aDomainOrHost;
    } else {
      throw e;
    }
  }
  return result;
}

// Here is a list of methods cleaners may implement. These methods must return a
// Promise object.
// * deleteAll() - this method _must_ exist. When called, it deletes all the
//                 data owned by the cleaner.
// * deleteByPrincipal() -  this method _must_ exist.
// * deleteByBaseDomain() - this method _must_ exist.
// * deleteByHost() - this method is implemented only if the cleaner knows
//                    how to delete data by host + originAttributes pattern. If
//                    not implemented, deleteAll() will be used as fallback.
// * deleteByRange() - this method is implemented only if the cleaner knows how
//                    to delete data by time range. It receives 2 time range
//                    parameters: aFrom/aTo. If not implemented, deleteAll() is
//                    used as fallback.
// * deleteByLocalFiles() - this method removes data held for local files and
//                          other hostless origins. If not implemented,
//                          **no fallback is used**, as for a number of
//                          cleaners, no such data will ever exist and
//                          therefore clearing it does not make sense.
// * deleteByOriginAttributes() - this method is implemented only if the cleaner
//                                knows how to delete data by originAttributes
//                                pattern.
// * cleanupAfterDeletionAtShutdown() - this method is implemented only if the
//                                      cleaner needs a separate step after
//                                      deletion. No-op if not implemented.
//                                      Currently called via
//                                      Sanitizer.maybeSanitizeSessionPrincipals().

const CookieCleaner = {
  deleteByLocalFiles(aOriginAttributes) {
    return new Promise(aResolve => {
      Services.cookies.removeCookiesFromExactHost(
        "",
        JSON.stringify(aOriginAttributes)
      );
      aResolve();
    });
  },

  deleteByHost(aHost, aOriginAttributes) {
    return new Promise(aResolve => {
      Services.cookies.removeCookiesFromExactHost(
        aHost,
        JSON.stringify(aOriginAttributes)
      );
      aResolve();
    });
  },

  deleteByPrincipal(aPrincipal) {
    // Fall back to clearing by host and OA pattern. This will over-clear, since
    // any properties that are not explicitly set in aPrincipal.originAttributes
    // will be wildcard matched.
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  async deleteByBaseDomain(aDomain) {
    Services.cookies.cookies
      .filter(({ rawHost, originAttributes }) =>
        hasBaseDomain({ host: rawHost, originAttributes }, aDomain)
      )
      .forEach(cookie => {
        Services.cookies.removeCookiesFromExactHost(
          cookie.rawHost,
          JSON.stringify(cookie.originAttributes)
        );
      });
  },

  deleteByRange(aFrom) {
    return Services.cookies.removeAllSince(aFrom);
  },

  deleteByOriginAttributes(aOriginAttributesString) {
    return new Promise(aResolve => {
      try {
        Services.cookies.removeCookiesWithOriginAttributes(
          aOriginAttributesString
        );
      } catch (ex) {}
      aResolve();
    });
  },

  deleteAll() {
    return new Promise(aResolve => {
      Services.cookies.removeAll();
      aResolve();
    });
  },
};

// A cleaner for clearing cookie banner handling exceptions.
const CookieBannerExceptionCleaner = {
  async deleteAll() {
    try {
      Services.cookieBanners.removeAllDomainPrefs(false);
    } catch (e) {
      // Don't throw an error if the cookie banner handling is disabled.
      if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
        throw e;
      }
    }
  },

  async deleteByPrincipal(aPrincipal) {
    try {
      Services.cookieBanners.removeDomainPref(aPrincipal.URI, false);
    } catch (e) {
      // Don't throw an error if the cookie banner handling is disabled.
      if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
        throw e;
      }
    }
  },

  async deleteByBaseDomain(aDomain) {
    try {
      Services.cookieBanners.removeDomainPref(
        Services.io.newURI("https://" + aDomain),
        false
      );
    } catch (e) {
      // Don't throw an error if the cookie banner handling is disabled.
      if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
        throw e;
      }
    }
  },

  async deleteByHost(aHost, aOriginAttributes) {
    try {
      let isPrivate =
        !!aOriginAttributes.privateBrowsingId &&
        aOriginAttributes.privateBrowsingId !==
          Services.scriptSecurityManager.DEFAULT_PRIVATE_BROWSING_ID;

      Services.cookieBanners.removeDomainPref(
        Services.io.newURI("https://" + aHost),
        isPrivate
      );
    } catch (e) {
      // Don't throw an error if the cookie banner handling is disabled.
      if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
        throw e;
      }
    }
  },
};

// A cleaner for cleaning cookie banner handling executed records.
const CookieBannerExecutedRecordCleaner = {
  async deleteAll() {
    try {
      Services.cookieBanners.removeAllExecutedRecords(false);
    } catch (e) {
      // Don't throw an error if the cookie banner handling is disabled.
      if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
        throw e;
      }
    }
  },

  async deleteByPrincipal(aPrincipal) {
    try {
      Services.cookieBanners.removeExecutedRecordForSite(
        aPrincipal.baseDomain,
        false
      );
    } catch (e) {
      // Don't throw an error if the cookie banner handling is disabled.
      if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
        throw e;
      }
    }
  },

  async deleteByBaseDomain(aDomain) {
    try {
      Services.cookieBanners.removeExecutedRecordForSite(aDomain, false);
    } catch (e) {
      // Don't throw an error if the cookie banner handling is disabled.
      if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
        throw e;
      }
    }
  },

  async deleteByHost(aHost, aOriginAttributes) {
    try {
      let isPrivate =
        !!aOriginAttributes.privateBrowsingId &&
        aOriginAttributes.privateBrowsingId !==
          Services.scriptSecurityManager.DEFAULT_PRIVATE_BROWSING_ID;

      Services.cookieBanners.removeExecutedRecordForSite(aHost, isPrivate);
    } catch (e) {
      // Don't throw error if the cookie banner handling is disabled.
      if (e.result != Cr.NS_ERROR_NOT_AVAILABLE) {
        throw e;
      }
    }
  },
};

// A cleaner for cleaning fingerprinting protection states.
const FingerprintingProtectionStateCleaner = {
  async deleteAll() {
    Services.rfp.cleanAllRandomKeys();
  },

  async deleteByPrincipal(aPrincipal) {
    Services.rfp.cleanRandomKeyByPrincipal(aPrincipal);
  },

  async deleteByBaseDomain(aDomain) {
    Services.rfp.cleanRandomKeyByDomain(aDomain);
  },

  async deleteByHost(aHost, aOriginAttributesPattern) {
    Services.rfp.cleanRandomKeyByHost(
      aHost,
      JSON.stringify(aOriginAttributesPattern)
    );
  },

  async deleteByOriginAttributes(aOriginAttributesString) {
    Services.rfp.cleanRandomKeyByOriginAttributesPattern(
      aOriginAttributesString
    );
  },
};

const CertCleaner = {
  async deleteByHost(aHost, aOriginAttributes) {
    let overrideService = Cc["@mozilla.org/security/certoverride;1"].getService(
      Ci.nsICertOverrideService
    );

    overrideService.clearValidityOverride(aHost, -1, aOriginAttributes);
  },

  deleteByPrincipal(aPrincipal) {
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  async deleteByBaseDomain(aBaseDomain) {
    let overrideService = Cc["@mozilla.org/security/certoverride;1"].getService(
      Ci.nsICertOverrideService
    );
    overrideService
      .getOverrides()
      .filter(({ asciiHost }) =>
        hasBaseDomain({ host: asciiHost }, aBaseDomain)
      )
      .forEach(({ asciiHost, port }) =>
        overrideService.clearValidityOverride(asciiHost, port, {})
      );
  },

  async deleteAll() {
    let overrideService = Cc["@mozilla.org/security/certoverride;1"].getService(
      Ci.nsICertOverrideService
    );

    overrideService.clearAllOverrides();
  },
};

const NetworkCacheCleaner = {
  async deleteByHost(aHost, aOriginAttributes) {
    // Delete data from both HTTP and HTTPS sites.
    let httpURI = Services.io.newURI("http://" + aHost);
    let httpsURI = Services.io.newURI("https://" + aHost);
    let httpPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      httpURI,
      aOriginAttributes
    );
    let httpsPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      httpsURI,
      aOriginAttributes
    );

    Services.cache2.clearOrigin(httpPrincipal);
    Services.cache2.clearOrigin(httpsPrincipal);
  },

  async deleteByBaseDomain(aBaseDomain) {
    Services.cache2.clearBaseDomain(aBaseDomain);
  },

  deleteByPrincipal(aPrincipal) {
    return new Promise(aResolve => {
      Services.cache2.clearOrigin(aPrincipal);
      aResolve();
    });
  },

  deleteByOriginAttributes(aOriginAttributesString) {
    return new Promise(aResolve => {
      Services.cache2.clearOriginAttributes(aOriginAttributesString);
      aResolve();
    });
  },

  deleteAll() {
    return new Promise(aResolve => {
      Services.cache2.clear();
      aResolve();
    });
  },
};

const CSSCacheCleaner = {
  async deleteByHost(aHost, aOriginAttributes) {
    // Delete data from both HTTP and HTTPS sites.
    let httpURI = Services.io.newURI("http://" + aHost);
    let httpsURI = Services.io.newURI("https://" + aHost);
    let httpPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      httpURI,
      aOriginAttributes
    );
    let httpsPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      httpsURI,
      aOriginAttributes
    );

    ChromeUtils.clearStyleSheetCacheByPrincipal(httpPrincipal);
    ChromeUtils.clearStyleSheetCacheByPrincipal(httpsPrincipal);
  },

  async deleteByPrincipal(aPrincipal) {
    ChromeUtils.clearStyleSheetCacheByPrincipal(aPrincipal);
  },

  async deleteByBaseDomain(aBaseDomain) {
    ChromeUtils.clearStyleSheetCacheByBaseDomain(aBaseDomain);
  },

  async deleteAll() {
    ChromeUtils.clearStyleSheetCache();
  },
};

const ImageCacheCleaner = {
  async deleteByHost(aHost, aOriginAttributes) {
    let imageCache = Cc["@mozilla.org/image/tools;1"]
      .getService(Ci.imgITools)
      .getImgCacheForDocument(null);

    // Delete data from both HTTP and HTTPS sites.
    let httpURI = Services.io.newURI("http://" + aHost);
    let httpsURI = Services.io.newURI("https://" + aHost);
    let httpPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      httpURI,
      aOriginAttributes
    );
    let httpsPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      httpsURI,
      aOriginAttributes
    );

    imageCache.removeEntriesFromPrincipalInAllProcesses(httpPrincipal);
    imageCache.removeEntriesFromPrincipalInAllProcesses(httpsPrincipal);
  },

  async deleteByPrincipal(aPrincipal) {
    let imageCache = Cc["@mozilla.org/image/tools;1"]
      .getService(Ci.imgITools)
      .getImgCacheForDocument(null);
    imageCache.removeEntriesFromPrincipalInAllProcesses(aPrincipal);
  },

  async deleteByBaseDomain(aBaseDomain) {
    let imageCache = Cc["@mozilla.org/image/tools;1"]
      .getService(Ci.imgITools)
      .getImgCacheForDocument(null);
    imageCache.removeEntriesFromBaseDomainInAllProcesses(aBaseDomain);
  },

  deleteAll() {
    return new Promise(aResolve => {
      let imageCache = Cc["@mozilla.org/image/tools;1"]
        .getService(Ci.imgITools)
        .getImgCacheForDocument(null);
      imageCache.clearCache(false); // true=chrome, false=content
      aResolve();
    });
  },
};

const DownloadsCleaner = {
  async _deleteInternal({ hostOrBaseDomain, principal, originAttributes }) {
    originAttributes = originAttributes || principal?.originAttributes || {};

    let list = await lazy.Downloads.getList(lazy.Downloads.ALL);
    list.removeFinished(({ source }) => {
      if (
        "userContextId" in originAttributes &&
        "userContextId" in source &&
        originAttributes.userContextId != source.userContextId
      ) {
        return false;
      }
      if (
        "privateBrowsingId" in originAttributes &&
        !!originAttributes.privateBrowsingId != source.isPrivate
      ) {
        return false;
      }

      let entryURI = Services.io.newURI(source.url);
      if (hostOrBaseDomain) {
        return Services.eTLD.hasRootDomain(entryURI.host, hostOrBaseDomain);
      }
      if (principal) {
        return principal.equalsURI(entryURI);
      }
      return false;
    });
  },

  async deleteByHost(aHost, aOriginAttributes) {
    // Clearing by host also clears associated subdomains.
    return this._deleteInternal({
      hostOrBaseDomain: aHost,
      originAttributes: aOriginAttributes,
    });
  },

  deleteByPrincipal(aPrincipal) {
    return this._deleteInternal({ principal: aPrincipal });
  },

  async deleteByBaseDomain(aBaseDomain) {
    return this._deleteInternal({ hostOrBaseDomain: aBaseDomain });
  },

  deleteByRange(aFrom, aTo) {
    // Convert microseconds back to milliseconds for date comparisons.
    let rangeBeginMs = aFrom / 1000;
    let rangeEndMs = aTo / 1000;

    return lazy.Downloads.getList(lazy.Downloads.ALL).then(aList => {
      aList.removeFinished(
        aDownload =>
          aDownload.startTime >= rangeBeginMs &&
          aDownload.startTime <= rangeEndMs
      );
    });
  },

  deleteAll() {
    return lazy.Downloads.getList(lazy.Downloads.ALL).then(aList => {
      aList.removeFinished(null);
    });
  },
};

const PasswordsCleaner = {
  deleteByHost(aHost) {
    // Clearing by host also clears associated subdomains.
    return this._deleteInternal(aLogin =>
      Services.eTLD.hasRootDomain(aLogin.hostname, aHost)
    );
  },

  deleteByPrincipal(aPrincipal) {
    // Login origins don't contain any origin attributes.
    return this._deleteInternal(
      aLogin => aLogin.origin == aPrincipal.originNoSuffix
    );
  },

  deleteByBaseDomain(aBaseDomain) {
    return this._deleteInternal(aLogin =>
      Services.eTLD.hasRootDomain(aLogin.hostname, aBaseDomain)
    );
  },

  deleteAll() {
    return this._deleteInternal(() => true);
  },

  async _deleteInternal(aCb) {
    try {
      let logins = await Services.logins.getAllLogins();
      for (let login of logins) {
        if (aCb(login)) {
          Services.logins.removeLogin(login);
        }
      }
    } catch (ex) {
      // XXXehsan: is there a better way to do this rather than this
      // hacky comparison?
      if (
        !ex.message.includes("User canceled Master Password entry") &&
        ex.result != Cr.NS_ERROR_NOT_IMPLEMENTED
      ) {
        throw new Error("Exception occured in clearing passwords: " + ex);
      }
    }
  },
};

const MediaDevicesCleaner = {
  async deleteByRange(aFrom) {
    let mediaMgr = Cc["@mozilla.org/mediaManagerService;1"].getService(
      Ci.nsIMediaManagerService
    );
    mediaMgr.sanitizeDeviceIds(aFrom);
  },

  // TODO: We should call the MediaManager to clear by principal, rather than
  // over-clearing for user requests or bailing out for programmatic calls.
  async deleteByPrincipal(aPrincipal, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  // TODO: Same as above, but for base domain.
  async deleteByBaseDomain(aBaseDomain, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  async deleteAll() {
    let mediaMgr = Cc["@mozilla.org/mediaManagerService;1"].getService(
      Ci.nsIMediaManagerService
    );
    mediaMgr.sanitizeDeviceIds(null);
  },
};

const QuotaCleaner = {
  /**
   * Clear quota storage for matching principals.
   * @param {function} filterFn - Filter function which is passed a principal.
   * Return true to clear storage for given principal or false to skip it.
   * @returns {Promise} - Resolves once all matching items have been cleared.
   * Rejects on error.
   */
  async _qmsClearStoragesForPrincipalsMatching(filterFn) {
    // Clearing quota storage by first getting all entry origins and then
    // iterating over them is not ideal, since we can not ensure an entirely
    // consistent clearing state. Between fetching the origins and clearing
    // them, additional entries could be added. This means we could end up with
    // stray entries after the clearing operation. To fix this we would need to
    // move the clearing code to the QuotaManager itself which could either
    // prevent new writes while clearing or clean up any additional entries
    // which get written during the clearing operation.
    // Performance is also not ideal, since we iterate over storage multiple
    // times for this two step process.
    // See Bug 1719195.
    let origins = await new Promise((resolve, reject) => {
      Services.qms.listOrigins().callback = request => {
        if (request.resultCode != Cr.NS_OK) {
          reject({ message: "Deleting quota storages failed" });
          return;
        }
        resolve(request.result);
      };
    });

    let clearPromises = origins
      // Parse origins into principals.
      .map(Services.scriptSecurityManager.createContentPrincipalFromOrigin)
      // Filter out principals that don't match the filterFn.
      .filter(filterFn)
      // Clear quota storage by principal and collect the promises.
      .map(
        principal =>
          new Promise((resolve, reject) => {
            let clearRequest =
              Services.qms.clearStoragesForPrincipal(principal);
            clearRequest.callback = () => {
              if (clearRequest.resultCode != Cr.NS_OK) {
                reject({ message: "Deleting quota storages failed" });
                return;
              }
              resolve();
            };
          })
      );
    return Promise.all(clearPromises);
  },

  deleteByPrincipal(aPrincipal) {
    // localStorage: The legacy LocalStorage implementation that will
    // eventually be removed depends on this observer notification to clear by
    // principal.
    Services.obs.notifyObservers(
      null,
      "extension:purge-localStorage",
      aPrincipal.host
    );

    // Clear sessionStorage
    Services.sessionStorage.clearStoragesForOrigin(aPrincipal);

    // ServiceWorkers: they must be removed before cleaning QuotaManager.
    return lazy.ServiceWorkerCleanUp.removeFromPrincipal(aPrincipal)
      .then(
        _ => /* exceptionThrown = */ false,
        _ => /* exceptionThrown = */ true
      )
      .then(exceptionThrown => {
        // QuotaManager: In the event of a failure, we call reject to propagate
        // the error upwards.
        return new Promise((aResolve, aReject) => {
          let req = Services.qms.clearStoragesForPrincipal(aPrincipal);
          req.callback = () => {
            if (exceptionThrown || req.resultCode != Cr.NS_OK) {
              aReject({ message: "Delete by principal failed" });
            } else {
              aResolve();
            }
          };
        });
      });
  },

  async deleteByBaseDomain(aBaseDomain) {
    // localStorage: The legacy LocalStorage implementation that will
    // eventually be removed depends on this observer notification to clear by
    // host.  Some other subsystems like Reporting headers depend on this too.
    Services.obs.notifyObservers(
      null,
      "extension:purge-localStorage",
      aBaseDomain
    );

    // Clear sessionStorage
    Services.obs.notifyObservers(
      null,
      "browser:purge-sessionStorage",
      aBaseDomain
    );

    // Clear third-party storage partitioned under aBaseDomain.
    // This notification is forwarded via the StorageObserver and consumed only
    // by the SessionStorageManager and (legacy) LocalStorageManager.
    // There is a similar (legacy) notification "clear-origin-attributes-data"
    // which additionally clears data across various other storages unrelated to
    // the QuotaCleaner.
    Services.obs.notifyObservers(
      null,
      "dom-storage:clear-origin-attributes-data",
      JSON.stringify({ partitionKeyPattern: { baseDomain: aBaseDomain } })
    );

    // ServiceWorkers must be removed before cleaning QuotaManager. We store
    // potential errors so we can re-throw later, once all operations have
    // completed.
    let swCleanupError;
    try {
      await lazy.ServiceWorkerCleanUp.removeFromBaseDomain(aBaseDomain);
    } catch (error) {
      swCleanupError = error;
    }

    await this._qmsClearStoragesForPrincipalsMatching(principal =>
      hasBaseDomain({ principal }, aBaseDomain)
    );

    // Re-throw any service worker cleanup errors.
    if (swCleanupError) {
      throw swCleanupError;
    }
  },

  async deleteByHost(aHost) {
    // XXX: The aOriginAttributes is expected to always be empty({}). Maybe have
    // a debug assertion here to ensure that?

    // localStorage: The legacy LocalStorage implementation that will
    // eventually be removed depends on this observer notification to clear by
    // host.  Some other subsystems like Reporting headers depend on this too.
    Services.obs.notifyObservers(null, "extension:purge-localStorage", aHost);

    // Clear sessionStorage
    Services.obs.notifyObservers(null, "browser:purge-sessionStorage", aHost);

    // ServiceWorkers must be removed before cleaning QuotaManager. We store any
    // errors so we can re-throw later once all operations have completed.
    let swCleanupError;
    try {
      await lazy.ServiceWorkerCleanUp.removeFromHost(aHost);
    } catch (error) {
      swCleanupError = error;
    }

    await this._qmsClearStoragesForPrincipalsMatching(principal => {
      try {
        // deleteByHost has the semantics that "foo.example.com" should be
        // wiped if we are provided an aHost of "example.com".
        return Services.eTLD.hasRootDomain(principal.host, aHost);
      } catch (e) {
        // There is no host for the given principal.
        return false;
      }
    });

    // Re-throw any service worker cleanup errors.
    if (swCleanupError) {
      throw swCleanupError;
    }
  },

  deleteByRange(aFrom, aTo) {
    let principals = lazy.sas
      .getActiveOrigins(aFrom, aTo)
      .QueryInterface(Ci.nsIArray);

    let promises = [];
    for (let i = 0; i < principals.length; ++i) {
      let principal = principals.queryElementAt(i, Ci.nsIPrincipal);

      if (
        !principal.schemeIs("http") &&
        !principal.schemeIs("https") &&
        !principal.schemeIs("file")
      ) {
        continue;
      }

      promises.push(this.deleteByPrincipal(principal));
    }

    return Promise.all(promises);
  },

  deleteByOriginAttributes(aOriginAttributesString) {
    // The legacy LocalStorage implementation that will eventually be removed.
    // And it should've been cleared while notifying observers with
    // clear-origin-attributes-data.

    return lazy.ServiceWorkerCleanUp.removeFromOriginAttributes(
      aOriginAttributesString
    )
      .then(
        _ => /* exceptionThrown = */ false,
        _ => /* exceptionThrown = */ true
      )
      .then(() => {
        // QuotaManager: In the event of a failure, we call reject to propagate
        // the error upwards.
        return new Promise((aResolve, aReject) => {
          let req = Services.qms.clearStoragesForOriginAttributesPattern(
            aOriginAttributesString
          );
          req.callback = () => {
            if (req.resultCode == Cr.NS_OK) {
              aResolve();
            } else {
              aReject({ message: "Delete by origin attributes failed" });
            }
          };
        });
      });
  },

  async deleteAll() {
    // localStorage
    Services.obs.notifyObservers(null, "extension:purge-localStorage");

    // sessionStorage
    Services.obs.notifyObservers(null, "browser:purge-sessionStorage");

    // ServiceWorkers must be removed before cleaning QuotaManager. We store any
    // errors so we can re-throw later once all operations have completed.
    let swCleanupError;
    try {
      await lazy.ServiceWorkerCleanUp.removeAll();
    } catch (error) {
      swCleanupError = error;
    }

    await this._qmsClearStoragesForPrincipalsMatching(
      principal =>
        principal.schemeIs("http") ||
        principal.schemeIs("https") ||
        principal.schemeIs("file")
    );

    // Re-throw any service worker cleanup errors.
    if (swCleanupError) {
      throw swCleanupError;
    }
  },

  async cleanupAfterDeletionAtShutdown() {
    const toBeRemovedDir = PathUtils.join(
      PathUtils.profileDir,
      Services.prefs.getStringPref("dom.quotaManager.storageName"),
      "to-be-removed"
    );

    if (
      !AppConstants.MOZ_BACKGROUNDTASKS ||
      !Services.prefs.getBoolPref("dom.quotaManager.backgroundTask.enabled")
    ) {
      await IOUtils.remove(toBeRemovedDir, { recursive: true });
      return;
    }

    const runner = Cc["@mozilla.org/backgroundtasksrunner;1"].getService(
      Ci.nsIBackgroundTasksRunner
    );

    runner.removeDirectoryInDetachedProcess(
      toBeRemovedDir,
      "",
      "0",
      "*", // wildcard
      "Quota"
    );
  },
};

const PredictorNetworkCleaner = {
  async deleteAll() {
    // Predictive network data - like cache, no way to clear this per
    // domain, so just trash it all
    let np = Cc["@mozilla.org/network/predictor;1"].getService(
      Ci.nsINetworkPredictor
    );
    np.reset();
  },

  // TODO: We should call the NetworkPredictor to clear by principal, rather
  // than over-clearing for user requests or bailing out for programmatic calls.
  async deleteByPrincipal(aPrincipal, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  // TODO: Same as above, but for base domain.
  async deleteByBaseDomain(aBaseDomain, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },
};

const PushNotificationsCleaner = {
  /**
   * Clear entries for aDomain including subdomains of aDomain.
   * @param {string} aDomain - Domain to clear data for.
   * @returns {Promise} a promise which resolves once data has been cleared.
   */
  _deleteByRootDomain(aDomain) {
    if (!Services.prefs.getBoolPref("dom.push.enabled", false)) {
      return Promise.resolve();
    }

    return new Promise((aResolve, aReject) => {
      let push = Cc["@mozilla.org/push/Service;1"].getService(
        Ci.nsIPushService
      );
      // ClearForDomain also clears subdomains.
      push.clearForDomain(aDomain, aStatus => {
        if (!Components.isSuccessCode(aStatus)) {
          aReject();
        } else {
          aResolve();
        }
      });
    });
  },

  deleteByHost(aHost) {
    // Will also clear entries for subdomains of aHost. Data is cleared across
    // all origin attributes.
    return this._deleteByRootDomain(aHost);
  },

  deleteByPrincipal(aPrincipal) {
    // Will also clear entries for subdomains of the principal host. Data is
    // cleared across all origin attributes.
    return this._deleteByRootDomain(aPrincipal.host);
  },

  deleteByBaseDomain(aBaseDomain) {
    return this._deleteByRootDomain(aBaseDomain);
  },

  deleteAll() {
    if (!Services.prefs.getBoolPref("dom.push.enabled", false)) {
      return Promise.resolve();
    }

    return new Promise((aResolve, aReject) => {
      let push = Cc["@mozilla.org/push/Service;1"].getService(
        Ci.nsIPushService
      );
      push.clearForDomain("*", aStatus => {
        if (!Components.isSuccessCode(aStatus)) {
          aReject();
        } else {
          aResolve();
        }
      });
    });
  },
};

const StorageAccessCleaner = {
  // This is a special function to implement deleteUserInteractionForClearingHistory.
  async deleteExceptPrincipals(aPrincipalsWithStorage, aFrom) {
    // We compare by base domain in order to simulate the behavior
    // from purging, Consider a scenario where the user is logged
    // into sub.example.com but the cookies are on example.com. In this
    // case, we will remove the user interaction for sub.example.com
    // because its principal does not match the one with storage.
    let baseDomainsWithStorage = new Set();
    for (let principal of aPrincipalsWithStorage) {
      baseDomainsWithStorage.add(principal.baseDomain);
    }
    for (let perm of Services.perms.getAllByTypeSince(
      "storageAccessAPI",
      // The permission manager uses milliseconds instead of microseconds
      aFrom / 1000
    )) {
      if (!baseDomainsWithStorage.has(perm.principal.baseDomain)) {
        Services.perms.removePermission(perm);
      }
    }
  },

  async deleteByPrincipal(aPrincipal) {
    return Services.perms.removeFromPrincipal(aPrincipal, "storageAccessAPI");
  },

  _deleteInternal(filter) {
    Services.perms.all
      .filter(({ type }) => type == "storageAccessAPI")
      .filter(filter)
      .forEach(perm => {
        try {
          Services.perms.removePermission(perm);
        } catch (ex) {
          console.error(ex);
        }
      });
  },

  async deleteByHost(aHost) {
    // Clearing by host also clears associated subdomains.
    this._deleteInternal(({ principal }) => {
      let toBeRemoved = false;
      try {
        toBeRemoved = Services.eTLD.hasRootDomain(principal.host, aHost);
      } catch (ex) {}
      return toBeRemoved;
    });
  },

  async deleteByBaseDomain(aBaseDomain) {
    this._deleteInternal(
      ({ principal }) => principal.baseDomain == aBaseDomain
    );
  },

  async deleteByRange(aFrom) {
    Services.perms.removeByTypeSince("storageAccessAPI", aFrom / 1000);
  },

  async deleteAll() {
    Services.perms.removeByType("storageAccessAPI");
  },
};

const HistoryCleaner = {
  deleteByHost(aHost) {
    if (!AppConstants.MOZ_PLACES) {
      return Promise.resolve();
    }
    return lazy.PlacesUtils.history.removeByFilter({ host: "." + aHost });
  },

  deleteByPrincipal(aPrincipal) {
    if (!AppConstants.MOZ_PLACES) {
      return Promise.resolve();
    }
    return lazy.PlacesUtils.history.removeByFilter({ host: aPrincipal.host });
  },

  deleteByBaseDomain(aBaseDomain) {
    return this.deleteByHost(aBaseDomain, {});
  },

  deleteByRange(aFrom, aTo) {
    if (!AppConstants.MOZ_PLACES) {
      return Promise.resolve();
    }
    return lazy.PlacesUtils.history.removeVisitsByFilter({
      beginDate: new Date(aFrom / 1000),
      endDate: new Date(aTo / 1000),
    });
  },

  deleteAll() {
    if (!AppConstants.MOZ_PLACES) {
      return Promise.resolve();
    }
    return lazy.PlacesUtils.history.clear();
  },
};

const SessionHistoryCleaner = {
  async deleteByHost(aHost) {
    // Session storage and history also clear subdomains of aHost.
    Services.obs.notifyObservers(null, "browser:purge-sessionStorage", aHost);
    Services.obs.notifyObservers(
      null,
      "browser:purge-session-history-for-domain",
      aHost
    );
  },

  deleteByPrincipal(aPrincipal) {
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  deleteByBaseDomain(aBaseDomain) {
    return this.deleteByHost(aBaseDomain, {});
  },

  async deleteByRange(aFrom) {
    Services.obs.notifyObservers(
      null,
      "browser:purge-session-history",
      String(aFrom)
    );
  },

  async deleteAll() {
    Services.obs.notifyObservers(null, "browser:purge-session-history");
  },
};

const AuthTokensCleaner = {
  // TODO: Bug 1726742
  async deleteByPrincipal(aPrincipal, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  // TODO: Bug 1726742
  async deleteByBaseDomain(aBaseDomain, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  async deleteAll() {
    let sdr = Cc["@mozilla.org/security/sdr;1"].getService(
      Ci.nsISecretDecoderRing
    );
    sdr.logoutAndTeardown();
  },
};

const AuthCacheCleaner = {
  // TODO: Bug 1726743
  async deleteByPrincipal(aPrincipal, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  // TODO: Bug 1726743
  async deleteByBaseDomain(aBaseDomain, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  deleteAll() {
    return new Promise(aResolve => {
      Services.obs.notifyObservers(null, "net:clear-active-logins");
      aResolve();
    });
  },
};

const PermissionsCleaner = {
  /**
   * Delete permissions by either base domain or host.
   * Clearing by host also clears associated subdomains.
   * For example, clearing "example.com" will also clear permissions for
   * "test.example.com" and "another.test.example.com".
   * @param options
   * @param {string} options.baseDomain - Base domain to delete permissions for.
   * @param {string} options.host - Host to delete permissions for.
   */
  async _deleteInternal({ baseDomain, host }) {
    for (let perm of Services.perms.all) {
      let toBeRemoved;

      if (baseDomain) {
        toBeRemoved = perm.principal.baseDomain == baseDomain;
      } else {
        try {
          toBeRemoved = Services.eTLD.hasRootDomain(perm.principal.host, host);
        } catch (ex) {
          continue;
        }
      }

      if (
        !toBeRemoved &&
        (perm.type.startsWith("3rdPartyStorage^") ||
          perm.type.startsWith("3rdPartyFrameStorage^"))
      ) {
        let parts = perm.type.split("^");
        let uri;
        try {
          uri = Services.io.newURI(parts[1]);
        } catch (ex) {
          continue;
        }

        toBeRemoved = Services.eTLD.hasRootDomain(uri.host, baseDomain || host);
      }

      if (!toBeRemoved) {
        continue;
      }

      try {
        Services.perms.removePermission(perm);
      } catch (ex) {
        // Ignore entry
      }
    }
  },

  deleteByHost(aHost) {
    return this._deleteInternal({ host: aHost });
  },

  deleteByPrincipal(aPrincipal) {
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  deleteByBaseDomain(aBaseDomain) {
    return this._deleteInternal({ baseDomain: aBaseDomain });
  },

  async deleteByRange(aFrom) {
    Services.perms.removeAllSince(aFrom / 1000);
  },

  async deleteByOriginAttributes(aOriginAttributesString) {
    Services.perms.removePermissionsWithAttributes(aOriginAttributesString);
  },

  async deleteAll() {
    Services.perms.removeAll();
  },
};

const PreferencesCleaner = {
  deleteByHost(aHost) {
    // Also clears subdomains of aHost.
    return new Promise((aResolve, aReject) => {
      let cps2 = Cc["@mozilla.org/content-pref/service;1"].getService(
        Ci.nsIContentPrefService2
      );
      cps2.removeBySubdomain(aHost, null, {
        handleCompletion: aReason => {
          if (aReason === cps2.COMPLETE_ERROR) {
            aReject();
          } else {
            aResolve();
          }
        },
        handleError() {},
      });
    });
  },

  deleteByPrincipal(aPrincipal) {
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  deleteByBaseDomain(aBaseDomain) {
    return this.deleteByHost(aBaseDomain, {});
  },

  async deleteByRange(aFrom) {
    let cps2 = Cc["@mozilla.org/content-pref/service;1"].getService(
      Ci.nsIContentPrefService2
    );
    cps2.removeAllDomainsSince(aFrom / 1000, null);
  },

  async deleteAll() {
    let cps2 = Cc["@mozilla.org/content-pref/service;1"].getService(
      Ci.nsIContentPrefService2
    );
    cps2.removeAllDomains(null);
  },
};

const ClientAuthRememberCleaner = {
  async deleteByHost(aHost, aOriginAttributes) {
    let cars = Cc[
      "@mozilla.org/security/clientAuthRememberService;1"
    ].getService(Ci.nsIClientAuthRememberService);

    cars.deleteDecisionsByHost(aHost, aOriginAttributes);
  },

  deleteByPrincipal(aPrincipal) {
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  async deleteByBaseDomain(aDomain) {
    let cars = Cc[
      "@mozilla.org/security/clientAuthRememberService;1"
    ].getService(Ci.nsIClientAuthRememberService);

    cars
      .getDecisions()
      .filter(({ asciiHost, entryKey }) => {
        // Get the origin attributes which are in the third component of the
        // entryKey. ',' is used as the delimiter.
        let originSuffixEncoded = entryKey.split(",")[2];
        let originAttributes;

        if (originSuffixEncoded) {
          try {
            // Decoding the suffix or parsing the origin attributes can fail. In
            // this case we won't match the partitionKey, but we can still match
            // the asciiHost.
            let originSuffix = decodeURIComponent(originSuffixEncoded);
            originAttributes =
              ChromeUtils.CreateOriginAttributesFromOriginSuffix(originSuffix);
          } catch (e) {
            console.error(e);
          }
        }

        return hasBaseDomain(
          {
            host: asciiHost,
            originAttributes,
          },
          aDomain
        );
      })
      .forEach(({ entryKey }) => cars.forgetRememberedDecision(entryKey));
  },

  async deleteAll() {
    let cars = Cc[
      "@mozilla.org/security/clientAuthRememberService;1"
    ].getService(Ci.nsIClientAuthRememberService);
    cars.clearRememberedDecisions();
  },
};

const HSTSCleaner = {
  async deleteByHost(aHost, aOriginAttributes) {
    let sss = Cc["@mozilla.org/ssservice;1"].getService(
      Ci.nsISiteSecurityService
    );
    let uri = Services.io.newURI("https://" + aHost);
    sss.resetState(
      uri,
      aOriginAttributes,
      Ci.nsISiteSecurityService.RootDomain
    );
  },

  /**
   * Adds brackets to a site if it's an IPv6 address.
   * @param {string} aSite - (schemeless) site which may be an IPv6.
   * @returns {string} bracketed IPv6 or site if site is not an IPv6.
   */
  _maybeFixIpv6Site(aSite) {
    // Not an IPv6 or already has brackets.
    if (!aSite.includes(":") || aSite[0] == "[") {
      return aSite;
    }
    return `[${aSite}]`;
  },

  deleteByPrincipal(aPrincipal) {
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  async deleteByBaseDomain(aDomain) {
    let sss = Cc["@mozilla.org/ssservice;1"].getService(
      Ci.nsISiteSecurityService
    );

    // Add brackets to IPv6 sites to ensure URI creation succeeds.
    let uri = Services.io.newURI("https://" + this._maybeFixIpv6Site(aDomain));
    sss.resetState(uri, {}, Ci.nsISiteSecurityService.BaseDomain);
  },

  async deleteAll() {
    // Clear site security settings - no support for ranges in this
    // interface either, so we clearAll().
    let sss = Cc["@mozilla.org/ssservice;1"].getService(
      Ci.nsISiteSecurityService
    );
    sss.clearAll();
  },
};

const EMECleaner = {
  async deleteByHost(aHost, aOriginAttributes) {
    let mps = Cc["@mozilla.org/gecko-media-plugin-service;1"].getService(
      Ci.mozIGeckoMediaPluginChromeService
    );
    mps.forgetThisSite(aHost, JSON.stringify(aOriginAttributes));
  },

  deleteByPrincipal(aPrincipal) {
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  async deleteByBaseDomain(aBaseDomain) {
    let mps = Cc["@mozilla.org/gecko-media-plugin-service;1"].getService(
      Ci.mozIGeckoMediaPluginChromeService
    );
    mps.forgetThisBaseDomain(aBaseDomain);
  },

  deleteAll() {
    // Not implemented.
    return Promise.resolve();
  },
};

const ReportsCleaner = {
  deleteByHost(aHost) {
    // Also clears subdomains of aHost.
    return new Promise(aResolve => {
      Services.obs.notifyObservers(null, "reporting:purge-host", aHost);
      aResolve();
    });
  },

  deleteByPrincipal(aPrincipal) {
    return this.deleteByHost(aPrincipal.host, aPrincipal.originAttributes);
  },

  deleteByBaseDomain(aBaseDomain) {
    return this.deleteByHost(aBaseDomain, {});
  },

  deleteAll() {
    return new Promise(aResolve => {
      Services.obs.notifyObservers(null, "reporting:purge-all");
      aResolve();
    });
  },
};

const ContentBlockingCleaner = {
  deleteAll() {
    return lazy.TrackingDBService.clearAll();
  },

  async deleteByPrincipal(aPrincipal, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  async deleteByBaseDomain(aBaseDomain, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  deleteByRange(aFrom) {
    return lazy.TrackingDBService.clearSince(aFrom);
  },
};

/**
 * The about:home startup cache, if it exists, might contain information
 * about where the user has been, or what they've downloaded.
 */
const AboutHomeStartupCacheCleaner = {
  async deleteByPrincipal(aPrincipal, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  async deleteByBaseDomain(aBaseDomain, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  deleteAll() {
    // This cleaner only makes sense on Firefox desktop, which is the only
    // application that uses the about:home startup cache.
    if (!AppConstants.MOZ_BUILD_APP == "browser") {
      return Promise.resolve();
    }

    return new Promise((aResolve, aReject) => {
      let lci = Services.loadContextInfo.default;
      let storage = Services.cache2.diskCacheStorage(lci);
      let uri = Services.io.newURI("about:home");
      try {
        storage.asyncDoomURI(uri, "", {
          onCacheEntryDoomed(aResult) {
            if (
              Components.isSuccessCode(aResult) ||
              aResult == Cr.NS_ERROR_NOT_AVAILABLE
            ) {
              aResolve();
            } else {
              aReject({
                message: "asyncDoomURI for about:home failed",
              });
            }
          },
        });
      } catch (e) {
        aReject({
          message: "Failed to doom about:home startup cache entry",
        });
      }
    });
  },
};

const PreflightCacheCleaner = {
  // TODO: Bug 1727141: We should call the cache to clear by principal, rather
  // than over-clearing for user requests or bailing out for programmatic calls.
  async deleteByPrincipal(aPrincipal, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  // TODO: Bug 1727141 (see deleteByPrincipal).
  async deleteByBaseDomain(aBaseDomain, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    await this.deleteAll();
  },

  async deleteAll() {
    Cc[`@mozilla.org/network/protocol;1?name=http`]
      .getService(Ci.nsIHttpProtocolHandler)
      .clearCORSPreflightCache();
  },
};

const IdentityCredentialStorageCleaner = {
  async deleteAll() {
    if (
      Services.prefs.getBoolPref(
        "dom.security.credentialmanagement.identity.enabled",
        false
      )
    ) {
      lazy.IdentityCredentialStorageService.clear();
    }
  },

  async deleteByPrincipal(aPrincipal) {
    if (
      Services.prefs.getBoolPref(
        "dom.security.credentialmanagement.identity.enabled",
        false
      )
    ) {
      lazy.IdentityCredentialStorageService.deleteFromPrincipal(aPrincipal);
    }
  },

  async deleteByBaseDomain(aBaseDomain, aIsUserRequest) {
    if (!aIsUserRequest) {
      return;
    }
    if (
      Services.prefs.getBoolPref(
        "dom.security.credentialmanagement.identity.enabled",
        false
      )
    ) {
      lazy.IdentityCredentialStorageService.deleteFromBaseDomain(aBaseDomain);
    }
  },

  async deleteByRange(aFrom, aTo) {
    if (
      Services.prefs.getBoolPref(
        "dom.security.credentialmanagement.identity.enabled",
        false
      )
    ) {
      lazy.IdentityCredentialStorageService.deleteFromTimeRange(aFrom, aTo);
    }
  },

  async deleteByHost(aHost, aOriginAttributes) {
    if (
      Services.prefs.getBoolPref(
        "dom.security.credentialmanagement.identity.enabled",
        false
      )
    ) {
      // Delete data from both HTTP and HTTPS sites.
      let httpURI = Services.io.newURI("http://" + aHost);
      let httpsURI = Services.io.newURI("https://" + aHost);
      let httpPrincipal = Services.scriptSecurityManager.createContentPrincipal(
        httpURI,
        aOriginAttributes
      );
      let httpsPrincipal =
        Services.scriptSecurityManager.createContentPrincipal(
          httpsURI,
          aOriginAttributes
        );
      lazy.IdentityCredentialStorageService.deleteFromPrincipal(httpPrincipal);
      lazy.IdentityCredentialStorageService.deleteFromPrincipal(httpsPrincipal);
    }
  },

  async deleteByOriginAttributes(aOriginAttributesString) {
    if (
      Services.prefs.getBoolPref(
        "dom.security.credentialmanagement.identity.enabled",
        false
      )
    ) {
      lazy.IdentityCredentialStorageService.deleteFromOriginAttributesPattern(
        aOriginAttributesString
      );
    }
  },
};

const BounceTrackingProtectionStateCleaner = {
  async deleteAll() {
    if (!lazy.isBounceTrackingProtectionEnabled) {
      return;
    }
    await lazy.bounceTrackingProtection.clearAll();
  },

  async deleteByPrincipal(aPrincipal) {
    if (!lazy.isBounceTrackingProtectionEnabled) {
      return;
    }
    let { baseDomain, originAttributes } = aPrincipal;
    await lazy.bounceTrackingProtection.clearBySiteHostAndOA(
      baseDomain,
      originAttributes
    );
  },

  async deleteByBaseDomain(aBaseDomain) {
    if (!lazy.isBounceTrackingProtectionEnabled) {
      return;
    }
    await lazy.bounceTrackingProtection.clearBySiteHost(aBaseDomain);
  },

  async deleteByRange(aFrom, aTo) {
    if (!lazy.isBounceTrackingProtectionEnabled) {
      return;
    }
    await lazy.bounceTrackingProtection.clearByTimeRange(aFrom, aTo);
  },

  async deleteByHost(aHost) {
    if (!lazy.isBounceTrackingProtectionEnabled) {
      return;
    }
    let baseDomain = getBaseDomainWithFallback(aHost);
    await lazy.bounceTrackingProtection.clearBySiteHost(baseDomain);
  },

  async deleteByOriginAttributes(aOriginAttributesPatternString) {
    if (!lazy.isBounceTrackingProtectionEnabled) {
      return;
    }
    await lazy.bounceTrackingProtection.clearByOriginAttributesPattern(
      aOriginAttributesPatternString
    );
  },
};

const StoragePermissionsCleaner = {
  async deleteByRange(aFrom) {
    // We lack the ability to clear by range, but can clear from a certain time to now
    // Convert aFrom from microseconds to ms
    Services.perms.removeByTypeSince("storage-access", aFrom / 1000);

    let persistentStoragePermissions = Services.perms.getAllByTypeSince(
      "persistent-storage",
      aFrom / 1000
    );
    persistentStoragePermissions.forEach(perm => {
      // If it is an Addon Principal, do nothing.
      // We want their persistant-storage permissions to remain (Bug 1907732)
      if (this._isAddonPrincipal(perm.principal)) {
        return;
      }
      Services.perms.removePermission(perm);
    });
  },

  async deleteByPrincipal(aPrincipal) {
    Services.perms.removeFromPrincipal(aPrincipal, "storage-access");

    // Only remove persistent-storage if it is not an extension principal (Bug 1907732)
    if (!this._isAddonPrincipal(aPrincipal)) {
      Services.perms.removeFromPrincipal(aPrincipal, "persistent-storage");
    }
  },

  async deleteByHost(aHost) {
    let permissions = this._getStoragePermissions();
    for (let perm of permissions) {
      if (Services.eTLD.hasRootDomain(perm.principal.host, aHost)) {
        Services.perms.removePermission(perm);
      }
    }
  },

  async deleteByBaseDomain(aBaseDomain) {
    let permissions = this._getStoragePermissions();
    for (let perm of permissions) {
      if (perm.principal.baseDomain == aBaseDomain) {
        Services.perms.removePermission(perm);
      }
    }
  },

  async deleteByLocalFiles() {
    let permissions = this._getStoragePermissions();
    for (let perm of permissions) {
      if (perm.principal.schemeIs("file")) {
        Services.perms.removePermission(perm);
      }
    }
  },

  async deleteAll() {
    Services.perms.removeByType("storage-access");

    // We don't want to clear the persistent-storage permission from addons (Bug 1907732)
    let persistentStoragePermissions = Services.perms.getAllByTypes([
      "persistent-storage",
    ]);
    persistentStoragePermissions.forEach(perm => {
      if (this._isAddonPrincipal(perm.principal)) {
        return;
      }

      Services.perms.removePermission(perm);
    });
  },

  _getStoragePermissions() {
    let storagePermissions = Services.perms.getAllByTypes([
      "storage-access",
      "persistent-storage",
    ]);

    return storagePermissions.filter(
      permission =>
        !this._isAddonPrincipal(permission.principal) ||
        permission.type == "storage-access"
    );
  },

  _isAddonPrincipal(aPrincipal) {
    return (
      // AddonPolicy() returns a WebExtensionPolicy that has been registered before,
      // typically during extension startup. Since Disabled or uninstalled add-ons
      // don't appear there, we should use schemeIs instead
      aPrincipal.schemeIs("moz-extension")
    );
  },
};

// Here the map of Flags-Cleaners.
const FLAGS_MAP = [
  {
    flag: Ci.nsIClearDataService.CLEAR_CERT_EXCEPTIONS,
    cleaners: [CertCleaner],
  },

  { flag: Ci.nsIClearDataService.CLEAR_COOKIES, cleaners: [CookieCleaner] },

  {
    flag: Ci.nsIClearDataService.CLEAR_NETWORK_CACHE,
    cleaners: [NetworkCacheCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_IMAGE_CACHE,
    cleaners: [ImageCacheCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_CSS_CACHE,
    cleaners: [CSSCacheCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_CLIENT_AUTH_REMEMBER_SERVICE,
    cleaners: [ClientAuthRememberCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_DOWNLOADS,
    cleaners: [DownloadsCleaner, AboutHomeStartupCacheCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_PASSWORDS,
    cleaners: [PasswordsCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_MEDIA_DEVICES,
    cleaners: [MediaDevicesCleaner],
  },

  { flag: Ci.nsIClearDataService.CLEAR_DOM_QUOTA, cleaners: [QuotaCleaner] },

  {
    flag: Ci.nsIClearDataService.CLEAR_PREDICTOR_NETWORK_DATA,
    cleaners: [PredictorNetworkCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_DOM_PUSH_NOTIFICATIONS,
    cleaners: [PushNotificationsCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_HISTORY,
    cleaners: [HistoryCleaner, AboutHomeStartupCacheCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_SESSION_HISTORY,
    cleaners: [SessionHistoryCleaner, AboutHomeStartupCacheCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_AUTH_TOKENS,
    cleaners: [AuthTokensCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_AUTH_CACHE,
    cleaners: [AuthCacheCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_PERMISSIONS,
    cleaners: [PermissionsCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_CONTENT_PREFERENCES,
    cleaners: [PreferencesCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_HSTS,
    cleaners: [HSTSCleaner],
  },

  { flag: Ci.nsIClearDataService.CLEAR_EME, cleaners: [EMECleaner] },

  { flag: Ci.nsIClearDataService.CLEAR_REPORTS, cleaners: [ReportsCleaner] },

  {
    flag: Ci.nsIClearDataService.CLEAR_STORAGE_ACCESS,
    cleaners: [StorageAccessCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_CONTENT_BLOCKING_RECORDS,
    cleaners: [ContentBlockingCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_PREFLIGHT_CACHE,
    cleaners: [PreflightCacheCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_CREDENTIAL_MANAGER_STATE,
    cleaners: [IdentityCredentialStorageCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_COOKIE_BANNER_EXCEPTION,
    cleaners: [CookieBannerExceptionCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_COOKIE_BANNER_EXECUTED_RECORD,
    cleaners: [CookieBannerExecutedRecordCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_FINGERPRINTING_PROTECTION_STATE,
    cleaners: [FingerprintingProtectionStateCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_BOUNCE_TRACKING_PROTECTION_STATE,
    cleaners: [BounceTrackingProtectionStateCleaner],
  },

  {
    flag: Ci.nsIClearDataService.CLEAR_STORAGE_PERMISSIONS,
    cleaners: [StoragePermissionsCleaner],
  },
];

export function ClearDataService() {
  this._initialize();
}

ClearDataService.prototype = Object.freeze({
  classID: Components.ID("{0c06583d-7dd8-4293-b1a5-912205f779aa}"),
  QueryInterface: ChromeUtils.generateQI(["nsIClearDataService"]),

  _initialize() {
    // Let's start all the service we need to cleanup data.

    // This is mainly needed for GeckoView that doesn't start QMS on startup
    // time.
    if (!Services.qms) {
      console.error("Failed initializiation of QuotaManagerService.");
    }
  },

  deleteDataFromLocalFiles(aIsUserRequest, aFlags, aCallback) {
    if (!aCallback) {
      return Cr.NS_ERROR_INVALID_ARG;
    }

    return this._deleteInternal(aFlags, aCallback, aCleaner => {
      // Some of the 'Cleaners' do not support clearing data for
      // local files. Ignore those.
      if (aCleaner.deleteByLocalFiles) {
        // A generic originAttributes dictionary.
        return aCleaner.deleteByLocalFiles({});
      }
      return Promise.resolve();
    });
  },

  deleteDataFromHost(aHost, aIsUserRequest, aFlags, aCallback) {
    if (!aHost || !aCallback) {
      return Cr.NS_ERROR_INVALID_ARG;
    }

    return this._deleteInternal(aFlags, aCallback, aCleaner => {
      // Some of the 'Cleaners' do not support to delete by principal. Let's
      // use deleteAll() as fallback.
      if (aCleaner.deleteByHost) {
        // A generic originAttributes dictionary.
        return aCleaner.deleteByHost(aHost, {});
      }
      // The user wants to delete data. Let's remove as much as we can.
      if (aIsUserRequest) {
        return aCleaner.deleteAll();
      }
      // We don't want to delete more than what is strictly required.
      return Promise.resolve();
    });
  },

  deleteDataFromBaseDomain(aDomainOrHost, aIsUserRequest, aFlags, aCallback) {
    if (!aDomainOrHost || !aCallback) {
      return Cr.NS_ERROR_INVALID_ARG;
    }
    // We may throw here if aDomainOrHost can't be converted to a base domain.
    let baseDomain;

    try {
      baseDomain = getBaseDomainWithFallback(aDomainOrHost);
    } catch (e) {
      return Cr.NS_ERROR_FAILURE;
    }

    return this._deleteInternal(aFlags, aCallback, aCleaner =>
      aCleaner.deleteByBaseDomain(baseDomain, aIsUserRequest)
    );
  },

  deleteDataFromPrincipal(aPrincipal, aIsUserRequest, aFlags, aCallback) {
    if (!aPrincipal || !aCallback) {
      return Cr.NS_ERROR_INVALID_ARG;
    }

    return this._deleteInternal(aFlags, aCallback, aCleaner =>
      aCleaner.deleteByPrincipal(aPrincipal, aIsUserRequest)
    );
  },

  deleteDataInTimeRange(aFrom, aTo, aIsUserRequest, aFlags, aCallback) {
    if (aFrom > aTo || !aCallback) {
      return Cr.NS_ERROR_INVALID_ARG;
    }

    return this._deleteInternal(aFlags, aCallback, aCleaner => {
      // Some of the 'Cleaners' do not support to delete by range. Let's use
      // deleteAll() as fallback.
      if (aCleaner.deleteByRange) {
        return aCleaner.deleteByRange(aFrom, aTo);
      }
      // The user wants to delete data. Let's remove as much as we can.
      if (aIsUserRequest) {
        return aCleaner.deleteAll();
      }
      // We don't want to delete more than what is strictly required.
      return Promise.resolve();
    });
  },

  deleteData(aFlags, aCallback) {
    if (!aCallback) {
      return Cr.NS_ERROR_INVALID_ARG;
    }

    return this._deleteInternal(aFlags, aCallback, aCleaner => {
      return aCleaner.deleteAll();
    });
  },

  deleteDataFromOriginAttributesPattern(aPattern, aCallback) {
    if (!aPattern) {
      return Cr.NS_ERROR_INVALID_ARG;
    }

    let patternString = JSON.stringify(aPattern);
    // XXXtt remove clear-origin-attributes-data entirely
    Services.obs.notifyObservers(
      null,
      "clear-origin-attributes-data",
      patternString
    );

    if (!aCallback) {
      aCallback = {
        onDataDeleted: () => {},
      };
    }
    return this._deleteInternal(
      Ci.nsIClearDataService.CLEAR_ALL,
      aCallback,
      aCleaner => {
        if (aCleaner.deleteByOriginAttributes) {
          return aCleaner.deleteByOriginAttributes(patternString);
        }

        // We don't want to delete more than what is strictly required.
        return Promise.resolve();
      }
    );
  },

  deleteUserInteractionForClearingHistory(
    aPrincipalsWithStorage,
    aFrom,
    aCallback
  ) {
    if (!aCallback) {
      return Cr.NS_ERROR_INVALID_ARG;
    }

    StorageAccessCleaner.deleteExceptPrincipals(aPrincipalsWithStorage, aFrom)
      .then(() => {
        aCallback.onDataDeleted(0);
      })
      .catch(() => {
        // This is part of clearing storageAccessAPI permissions, thus return
        // an appropriate error flag.
        aCallback.onDataDeleted(Ci.nsIClearDataService.CLEAR_PERMISSIONS);
      });
    return Cr.NS_OK;
  },

  cleanupAfterDeletionAtShutdown(aFlags, aCallback) {
    return this._deleteInternal(aFlags, aCallback, async aCleaner => {
      if (aCleaner.cleanupAfterDeletionAtShutdown) {
        await aCleaner.cleanupAfterDeletionAtShutdown();
      }
    });
  },

  // This internal method uses aFlags against FLAGS_MAP in order to retrieve a
  // list of 'Cleaners'. For each of them, the aHelper callback retrieves a
  // promise object. All these promise objects are resolved before calling
  // onDataDeleted.
  _deleteInternal(aFlags, aCallback, aHelper) {
    let resultFlags = 0;
    let promises = FLAGS_MAP.filter(c => aFlags & c.flag).map(c => {
      return Promise.all(
        c.cleaners.map(cleaner => {
          return aHelper(cleaner).catch(e => {
            console.error(e);
            resultFlags |= c.flag;
          });
        })
      );
      // Let's collect the failure in resultFlags.
    });
    Promise.all(promises).then(() => {
      aCallback.onDataDeleted(resultFlags);
    });
    return Cr.NS_OK;
  },
});
