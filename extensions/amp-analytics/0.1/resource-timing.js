/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {user} from '../../../src/log';
import {isObject} from '../../../src/types';
import {parseUrl} from '../../../src/url';
import {findIndex} from '../../../src/utils/array';
import {ExpansionOptions, variableServiceFor} from './variables';

/**
 * A user-supplied JSON object that defines a resource to be reported. It is
 * expected to have some fields.
 * A resource timing enty will match against this resource if all of the
 * following properties match.
 * @property {string=} host A string whose value should be a RegExp. It defines
 *     a host or set of hosts to match against. By default, the RegExp will
 *     match all hosts if omitted.
 * @property {string=} path A string whose value should be a RegExp. It defines
 *     a path or set of paths to match against. By default, the RegExp will
 *     match all paths if omitted.
 * @property {string=} query A string whose value should be a RegExp. It defines
 *     a query string or set of query strings to match against. By default, the
 *     RegExp will match all query strings if omitted.
 * @typedef {!JsonObject}
 */
let IndividualResourceSpecDef;

/**
 * A parsed resource spec for a specific host or sets of hosts (as defined by
 * the hostPattern).
 * @typedef{{
 *   hostPattern: !RegExp,
 *   resouces: !Array<{
 *     name: string,
 *     pathPattern: !RegExp,
 *     queryPattern: !RegExp,
 *   }>,
 * }}
 */
let ResourceSpecForHostDef;

/**
 * Yields the thread before running the function to avoid causing jank. (i.e. a
 * task that takes over 16ms.)
 * @param {function(): OUT} fn
 * @return {!Promise<OUT>}
 * @template OUT
 */
function yieldThread(fn) {
  return new Promise(resolve => {
    setTimeout(() => resolve(fn()));
  });
}

/**
 * Checks whether the given object is a valid resource timing spec.
 * @param {!JsonObject} spec
 * @return {boolean}
 */
function validateResourceTimingSpec(spec) {
  if (!isObject(spec['resources'])) {
    user().warn('ANALYTICS', 'resourceTimingSpec missing "resources" field');
    return false;
  }
  if (!spec['encoding'] || !spec['encoding']['entry'] ||
      !spec['encoding']['delim']) {
    user().warn(
        'ANALYTICS',
        'resourceTimingSpec is missing or has incomplete encoding options');
    return false;
  }
  if (spec['encoding']['base'] < 2 || spec['encoding']['base'] > 36) {
    user().warn(
        'ANALYTICS',
        'resource timing variables only supports bases between 2 and 36');
    return false;
  }
  return true;
}

/**
 * Gets all resource timing entries from the given window.
 * @param {!Window} win
 * @return {!Array<!PerformanceResourceTiming>}
 */
function getResourceTimingEntries(win) {
  if (!win.performance || !win.performance.getEntriesByType) {
    return [];
  }
  return /** @type {!Array<!PerformanceResourceTiming>} */ (
    win.performance.getEntriesByType('resource'));
}

/**
 * Converts a resource timing entry to the variables for this resource.
 * @param {!PerformanceResourceTiming} entry
 * @param {string} name Name of the resource set by the resourceTimingSpec.
 * @param {function(number, number=): string} format A function to format
 *    timestamps and intervals. (Two numbers will be passed in for intervals.)
 * @return {!ExpansionOptions}
 */
function entryToExpansionOptions(entry, name, format) {
  const vars = {
    // ${key} is the name of the resource from the resourceTimingSpec. i.e. it's
    // the key of the object that specifies the host and path patterns that this
    // resource matched against.
    'key': name,
    'startTime': format(entry.startTime),
    'redirectTime': format(entry.redirectEnd, entry.redirectStart),
    'domainLookupTime': format(entry.domainLookupEnd, entry.domainLookupStart),
    'tcpConnectTime': format(entry.connectEnd, entry.connectStart),
    'serverResponseTime': format(entry.responseStart, entry.requestStart),
    'networkTransferTime': format(entry.responseEnd, entry.responseStart),
    'transferSize': format(entry.transferSize || 0),
    'encodedBodySize': format(entry.encodedBodySize || 0),
    'decodedBodySize': format(entry.decodedBodySize || 0),
    'duration': format(entry.duration),
    'initiatorType': entry.initiatorType,
  };
  return new ExpansionOptions(vars, 1 /* opt_iterations */);
};

/**
 * Returns the variables for the given resource timing entry if it matches one
 * of the defined resources, or null otherwise.
 * @param {!PerformanceResourceTiming} entry
 * @param {!Array<!ResourceSpecForHostDef>} resourcesByHost An array of resource
 *     specs to match against.
 * @return {?string} The name of the entry, or null if no matching name exists.
 */
function nameForEntry(entry, resourcesByHost) {
  const url = parseUrl(entry.name);
  for (let i = 0; i < resourcesByHost.length; ++i) {
    const {hostPattern, resources} = resourcesByHost[i];
    if (!hostPattern.test(url.host)) {
      continue;
    }
    const index = findIndex(
        resources,
        res => res.pathPattern.test(url.pathname) &&
            res.queryPattern.test(url.search));
    if (index != -1) {
      return resources[index].name;
    }
  }
  return null; // No match.
}

/**
 * Groups all resource specs (which are defined in terms of {host, path, query}
 * patterns) by host pattern. This is used downstream to avoid running RegExps
 * for host patterns multiple times because we expect multiple resources to
 * use the same host pattern.
 * @param {!Object<string, !IndividualResourceSpecDef>} resourceDefs A map of
 *     names to the resource spec for that name.
 * @return {!Array<!ResourceSpecForHostDef>}
 */
function groupSpecsByHost(resourceDefs) {
  const byHost = {};
  for (const name in resourceDefs) {
    const host = resourceDefs[name]['host'] || '';
    const path = resourceDefs[name]['path'] || '';
    const query = resourceDefs[name]['query'] || '';
    const pattern = {
      name,
      pathPattern: new RegExp(path),
      queryPattern: new RegExp(query),
    };
    if (byHost[host]) {
      byHost[host].resources.push(pattern);
    } else {
      byHost[host] = {
        hostPattern: new RegExp(host),
        resources: [pattern],
      };
    }
  }
  const byHostArray = [];
  for (const host in byHost) {
    byHostArray.push(byHost[host]);
  }
  return byHostArray;
}

/**
 * Filters out resource timing entries that don't have a name defined in
 * resourceDefs. It returns a new array where each element contains a
 * resource timing entry and the corresponding name.
 * @param {!Array<!PerformanceResourceTiming>} entries
 * @param {!Object<string, !IndividualResourceSpecDef>} resourceDefs
 * @return {!Array<{entry: !PerformanceResourceTiming, name: string}>}
 */
function filterEntries(entries, resourceDefs) {
  // Group resource timing definitions by host since we expect multiple
  // definitions to have the same host.
  const byHost = groupSpecsByHost(resourceDefs);
  const results = [];
  entries.forEach(entry => {
    const name = nameForEntry(entry, byHost);
    if (name) {
      results.push({entry, name});
    }
  });
  return results;
}

/**
 * Serializes resource timing entries that match the resourceTimingSpec into a
 * single string.
 * @param {!Array<!PerformanceResourceTiming>} entries
 * @param {!JsonObject} resourceTimingSpec
 * @param {!Window} win
 * @return {!Promise<string>}
 */
function serialize(entries, resourceTimingSpec, win) {
  const resources = resourceTimingSpec['resources'];
  const encoding = resourceTimingSpec['encoding'];

  const variableService = variableServiceFor(win);
  const format = (val, relativeTo = 0) =>
    Math.round(val - relativeTo).toString(encoding['base'] || 10);

  const promises =
      filterEntries(entries, resources)
          .map(({entry, name}) => entryToExpansionOptions(entry, name, format))
          .map(
              expansion =>
                variableService.expandTemplate(encoding['entry'], expansion));
  return Promise.all(promises).then(vars => vars.join(encoding['delim']));
}

/**
 * Serializes resource timing entries according to the resource timing spec.
 * @param {!JsonObject} resourceTimingSpec
 * @param {!Window} win
 * @return {!Promise<string>}
 */
export function serializeResourceTiming(resourceTimingSpec, win) {
  if (!validateResourceTimingSpec(resourceTimingSpec)) {
    return Promise.resolve('');
  }
  const entries = getResourceTimingEntries(win);
  if (!entries.length) {
    return Promise.resolve('');
  }
  // Yield the thread in case iterating over all resources takes a long time.
  return yieldThread(() => serialize(entries, resourceTimingSpec, win));
}