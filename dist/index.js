'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

/**
 * Thorn Node.js module for REST API testing SugarCRM with Chakram.
 *
 * @module thorn
 */

var chakram = require('chakram');
var MetadataFetcher = require('./metadatafetcher.js');
var _ = require('lodash');

/**
 * Root URL of SugarCRM instance to test.
 * @type {string}
 * @private
 */
var ROOT_URL = process.env.API_URL;
if (!ROOT_URL) {
    throw new Error('Please set process.env.API_URL!');
}

/**
 * Mimics default version until we have a way to get it from the instance being tested.
 * @type {string}
 * @private
 */
var VERSION = 'v10';

/**
 * Record map indexed by module names.
 *
 * Note that each record is the response body from the API server.
 *
 * Example:
 *     {
 *       Accounts: [ob1, ob2],
 *       Contacts: [ob1, ob2],
 *       //...
 *     }
 *
 * @type {Object}
 * @private
 */
var cachedRecords = {};

/**
 * Credentials for created records.
 *
 * Example:
 *  {
 *      jon: 'jon',
 *      jane: 'jane'
 *  }
 *
 * @type {Object}
 * @private
 */
var credentials = {};

/**
 * Record map indexed by fixture.
 *
 * @type WeakMap<Object, Object>
 * @private
 */
var fixturesMap = new WeakMap();

var Fixtures = {
    /**
     * @property {number} _sessionAttempt Number of attempts made to login as
     *   admin.
     *
     * @private
     */
    _sessionAttempt: 0,

    /**
     * @property {number} _maxSessionAttempts Maximum number of login attempts
     *   allowed.
     *
     * @private
     */
    _maxSessionAttempts: 3,

    /**
     * @property {object} _headers Default HTTP headers.
     */
    _headers: {
        'Content-Type': 'application/json',
        'X-Thorn': 'Fixtures'
    },

    /**
     * Using the supplied models, create records and links on the server cache those records locally.
     *
     * @param {Object|Object[]} models An object or array of objects.
     *   Each object contains a list of attributes for each new model.
     * @param {Object} [options]
     * @param {string} [options.module] The module of all models (if not specified in the models' object).
     *
     * @return {Promise} The ChakramResponse from the creation of the records and/or links
     */
    create: function create(models) {
        var _this = this;

        var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

        if (_.isUndefined(this._headers['OAuth-Token'])) {
            if (++this._sessionAttempt > this._maxSessionAttempts) {
                throw new Error('Max number of login attempts exceeded!');
            }

            return this._adminLogin().then(function () {
                return _this.create(models, options);
            });
        }

        if (!_.isArray(models)) {
            models = [models];
        }

        // reset #_sessionAttempt
        this._sessionAttempt = 0;

        var url = _constructUrl('bulk', VERSION);
        var params = { headers: this._headers };
        var bulkRecordCreateDef = this._processModels(models, options);
        var bulkRecordLinkDef = void 0;

        // return Promise
        return _wrap401(chakram.post, [url, bulkRecordCreateDef, params], this._refreshToken, _.bind(this._afterRefresh, this)).then(function (reponse) {
            bulkRecordLinkDef = _this._processRecords(response, models);
            return chakram.post(url, bulkRecordLinkDef, params);
        }).then(function () {
            return cachedRecords;
        }).catch(function (err) {
            console.error(err);
        });
    },


    /**
     * Generates the bulk call object for linking based on response from record
     * creation.
     *
     * @param {Object} response Response object from record creation bulk call.
     * @param {Object[]} models
     *
     * @return {Object} Bulk call object for links.
     *
     * @private
     */
    _processRecords: function _processRecords(response, models) {
        var bulkRecordLinkDef = { requests: [] };
        var records = response.response.body;
        var modelIndex = 0;

        // Loop chakram response for each record
        _.each(records, function (record) {
            var contents = record.contents;
            var recordModule = contents._module;
            // Cache record into fixturesMap
            // The bulk response is in the same order as the supplied requests.
            fixturesMap.set(models[modelIndex++], contents);
            // Cache record into cachedRecords indexed by supplied module
            if (cachedRecords[recordModule]) {
                cachedRecords[recordModule].push(contents);
            } else {
                cachedRecords[recordModule] = [contents];
            }
        });

        // Loop models to handle links
        _.each(models, function (model) {
            var leftID = fixturesMap.get(model).id;
            _.each(model.links, function (moduleLinks, linkToModule) {
                _.each(moduleLinks, function (link) {
                    var cachedRecord = fixturesMap.get(link);
                    if (!cachedRecord) {
                        console.error('Missing link!');
                        throw new Error(link.toString());
                    }
                    var request = {
                        url: '/' + VERSION + '/' + model.module + '/' + leftID + '/link',
                        method: 'POST',
                        data: {
                            link_name: linkToModule,
                            ids: [cachedRecord.id]
                        }
                    };

                    bulkRecordLinkDef.requests.push(request);
                });
            });
        });

        return bulkRecordLinkDef;
    },


    /**
     * Generates the bulk call object for object creation based on models.
     *
     * @param {Object[]} models
     * @param {Object} [options]
     *
     * @return {Object} Bulk call object for record creation.
     *
     * @private
     */
    _processModels: function _processModels(models) {
        var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

        var bulkRecordCreateDef = { requests: [] };
        // Loop models to check if any model has been cached already
        // Fetch module's required fields and pre-fill them
        _.each(models, function (model) {
            model.module = model.module || options.module;
            var requiredFields = void 0;
            var request = {
                url: '/' + VERSION + '/' + model.module,
                method: 'POST',
                data: model.attributes || {}
            };

            if (!model.module) {
                console.error('Missing module name!');
                throw new Error(model.toString());
            }
            if (fixturesMap.has(model)) {
                console.error('Record already exists!');
                throw new Error(model.toString());
            }

            requiredFields = MetadataFetcher.fetchRequiredFields(model.module);
            _.each(requiredFields, function (field) {
                if (!request.data[field.name]) {
                    request.data[field.name] = MetadataFetcher.generateFieldValue(field.type, field.reqs);
                }
            });

            // Use chakram.post (with Header X-Fixtures: true) to bulk create the record(s).
            bulkRecordCreateDef.requests.push(request);
        });

        return bulkRecordCreateDef;
    },


    /**
     * Removes all cached records from the server. Additionally, clears the local cache.
     *
     * @return {Promise} The ChakramResponse for the delete request to the server.
     */
    cleanup: function cleanup() {
        var _this2 = this;

        if (_.isUndefined(this._headers['OAuth-Token'])) {
            if (++this._sessionAttempt > this._maxSessionAttempts) {
                throw new Error('Max number of login attempts exceeded!');
            }

            return this._adminLogin().then(function () {
                return _this2.cleanup();
            });
        }

        // reset #_sessionAttempt
        this._sessionAttempt = 0;

        // Create promise for record deletion
        // Clear the cache
        // Return promise
        var bulkRecordDeleteDef = { requests: [] };
        var url = _constructUrl('bulk', VERSION);
        var params = { headers: this._headers };

        _.each(cachedRecords, function (moduleRecords, module) {
            _.each(moduleRecords, function (record) {
                bulkRecordDeleteDef.requests.push({
                    url: '/' + VERSION + '/' + module + '/' + record.id,
                    method: 'DELETE'
                });
            });
        });

        // Create promise for record deletion
        return _wrap401(chakram.post, [url, bulkRecordDeleteDef, params], this._refreshToken, _.bind(this._afterRefresh, this)).then(function () {
            cachedRecords = null;
        }).catch(function (err) {
            console.error(err);
        });
    },


    /**
     * Mimics _.find and using the supplied arguments, returns the cached record(s).
     *
     * @param {string} module The module of the record(s) to find
     * @param {Object} properties The properties to search for
     *
     * @return {Object} The first record in #cachedRecords that match properties
     */
    lookup: function lookup(module, properties) {
        var records = cachedRecords[module];
        if (!records) {
            throw new Error('No cached records found for module: ' + module);
        }

        return _.find(records, properties);
    },


    /**
     * Creates link between `left` and `right` in the database.
     *
     * @param {Object} left Record retrieved from cache.
     * @param {string} linkName Relationship link name.
     * @param {Object} right Record retrieved from cache.
     *
     * @return {Promise} ChakramPromise
     */
    link: function link(left, linkName, right) {
        var url = '/' + VERSION + '/' + left._module + '/' + left.id + '/link';
        var params = { headers: this._headers };
        var linkDef = {
            link_name: linkName,
            ids: [right.id]
        };

        return _wrap401(chakram.post, [url, linkDef, params], this._refreshToken, _.bind(this._afterRefresh, this)).catch(function (err) {
            console.error(err);
        });
    },


    /**
     * Stores the login response.
     *
     * @param {Object} auth The login response.
     */
    _storeAuth: function _storeAuth(auth) {
        this._headers['OAuth-Token'] = auth.body.access_token;
        this._refreshToken = auth.body.refresh_token;
    },


    /**
     * Logins as the admin user.
     *
     * @return {Promise} ChakramPromise
     *
     * @private
     */
    _adminLogin: function _adminLogin() {
        var _this3 = this;

        var credentials = {
            username: process.env.ADMIN_USERNAME,
            password: process.env.ADMIN_PASSWORD,
            grant_type: 'password',
            client_id: 'sugar',
            client_secret: ''
        };
        var url = _constructUrl('oauth2/token', VERSION);

        return chakram.post(url, credentials).then(function (response) {
            _this3._storeAuth(response);
        });
    },


    /**
     * Callback to be performed after a refresh.
     *
     * @param {object} response Chakram refresh response.
     * @private
     */
    _afterRefresh: function _afterRefresh(response) {
        this._headers['OAuth-Token'] = response.body.access_token;
        this._refreshToken = response.body.refresh_token;
    }
};

// ********************************************************************************************************************

/**
 * Map between usernames and agent instances.
 *
 * @type {Object}
 * @private
 */
var cachedAgents = {};

/**
 * Namespace for UserAgent access methods.
 */

var Agent = function () {
    function Agent() {
        _classCallCheck(this, Agent);
    }

    _createClass(Agent, null, [{
        key: 'as',

        /**
         * Return a UserAgent with the given user name and log them in.
         *
         * @param {string} username Username of the user agent.
         * @return {UserAgent} A UserAgent corresponding to the user with the given username.
         */
        value: function as(username) {
            if (!username) {
                throw new Error('Tried to create a user agent with no username!');
            }

            var cachedAgent = cachedAgents[username];
            if (cachedAgent) {
                return cachedAgent;
            }
            var agent = new UserAgent(username, credentials[username], VERSION);
            agent._login();
            return agent;
        }
    }]);

    return Agent;
}();

/**
 * Tries a request. If it fails because of HTTP 401, do a refresh and then try again.
 *
 * @param {function} chakramMethod Chakram request method to call.
 * @param {array} args Arguments to call the chakram request method with.
 *   The last member of the array must be a `params`-like object.
 * @param {string} refreshToken Refresh token to use if you have to do a refresh.
 * @param {function} afterRefresh Additional tasks to be performed after
 *   a refresh occurs. Passed the chakram response object from the refresh.
 * @param {string} [version=VERSION] API version to make the retry request on.
 *   Non-retry requests are made on whatever version is specified by `args`.
 * @return {ChakramPromise} A promise resolving to the result of the request.
 *   If the first try failed, it will resolve to the result of the second,
 *   whether it succeeded or not.
 *
 * @private
 */


function _wrap401(chakramMethod, args, refreshToken, afterRefresh) {
    var retryVersion = arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : VERSION;

    return chakramMethod.apply(chakram, args).then(function (response) {
        if (response.response.statusCode !== 401) {
            return response;
        }

        return _refresh(retryVersion, refreshToken).then(function (response) {
            afterRefresh(response);

            // FIXME THIS SUCKS
            // have to update parameters after a refresh
            var paramIndex = args.length - 1;
            args[paramIndex].headers['OAuth-Token'] = response.body.access_token;
            return chakramMethod.apply(chakram, args);
        });
    }, function (response) {
        console.err('Failing even after a refresh');
    });
}

/**
 * Refresh the user with the given refresh token.
 *
 * @param {string} version API version to do the refresh request on.
 * @param {string} token The refresh token of the user you wish to refresh.
 * @return {ChakramPromise} A promise which resolves to the Chakram refresh response.
 *
 * @private
 */
function _refresh(version, token) {
    var credentials = {
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: 'sugar',
        client_secret: ''
    };
    var url = _constructUrl('oauth2/token', version);
    return chakram.post(url, credentials);
}

/**
 * Return the URL needed to access the given endpoint.
 *
 * @param {string} endpoint API endpoint to access.
 * @param {string} version API version to make the request against.
 * @return {string} The full URL to access that endpoint.
 * @private
 */
// FIXME: argument order feels backwards!
// but we could give the version a default value this way...
function _constructUrl(endpoint, version) {
    return [ROOT_URL, version, endpoint].join('/');
}

/**
 * Username for the SugarCRM administrative user.
 *
 * @property {string}
 */
Agent.ADMIN = process.env.ADMIN_USERNAME;
Object.freeze(Agent);

/**
 * Class simulating a web browser user.
 */

var UserAgent = function () {
    /**
     * Create a new UserAgent.
     *
     * @param {string} username User name.
     * @param {string} password Password.
     * @param {string} version API version.
     */
    function UserAgent(username, password, version) {
        var _this4 = this;

        _classCallCheck(this, UserAgent);

        this._login = function () {
            var credentials = {
                username: _this4.username,
                password: _this4.password,
                grant_type: 'password',
                client_id: 'sugar',
                client_secret: ''
            };

            var url = _constructUrl('oauth2/token', _this4.version);
            _this4._loginPromise = chakram.post(url, credentials).then(function (response) {
                cachedAgents[_this4.username] = _this4;
                _this4._headers['OAuth-Token'] = response.body.access_token;
                _this4._refreshToken = response.body.refresh_token;
            }, function (response) {
                console.error('Logging in user ' + _this4.username + ' failed!');
            });
        };

        this._requestSkeleton = function (chakramMethod, args) {
            args[0] = _constructUrl(args[0], _this4.version);

            return _this4._loginPromise.then(function () {
                // must wait for login promise to resolve or else OAuth-Token may not be available
                var paramIndex = args.length - 1;
                // FIXME: eventually will want to support multiple types of headers
                args[paramIndex] = args[paramIndex] || { headers: {} };
                _.extend(args[paramIndex].headers, _this4._headers);
                return _wrap401(chakramMethod, args, _this4._refreshToken, _.bind(_this4._afterRefresh, _this4), _this4.version);
            }, function () {
                console.error('Making a ' + chakramMethod.name + ' request failed!');
            });
        };

        this._afterRefresh = function (response) {
            _this4._headers['OAuth-Token'] = response.body.access_token;
            _this4._refreshToken = response.body.refresh_token;
        };

        this.username = username;
        this.password = password;
        this.version = version;

        this._headers = {
            'Content-Type': 'application/json',
            'X-Thorn': 'Agent'
        };
    }

    /**
     * Clones this user agent and sets its API version.
     * If the supplied version matches the previously supplied version,
     * the same agent instance is returned.
     *
     * @param {string} version API version to switch to.
     * @return {Agent} A UserAgent set to use the given API version.
     */


    _createClass(UserAgent, [{
        key: 'on',
        value: function on(version) {
            if (version === this.version) {
                return this;
            }
            var agentClone = _.clone(this);
            agentClone.version = version;
            return agentClone;
        }

        /**
         * Log this user agent in.
         * After calling this function, `this._loginPromise` is set to a promise
         * that, when resolved, will verify that the OAuth token is available.
         *
         * @private
         */


        /**
         * Skeleton method for making a chakram request.
         *
         * @param {function} chakramMethod Chakram request method to call.
         * @param {array} args Arguments to call the chakram request method with.
         *   The first member of the array must be the desired endpoint;
         *   the last must be a `params`-like object.
         * @return {ChakramPromise} A promise resolving to the result of the request.
         * @private
         */


        /**
         * Callback to be performed after a refresh.
         *
         * @param {object} response Chakram refresh response.
         * @private
         */

    }, {
        key: 'get',


        /**
         * Perform a GET request as this user.
         *
         * @param {string} endpoint API endpoint to make the request to.
         * @param {Object} [params] Request parameters.
         * @return {ChakramPromise} A promise which resolves to the Chakram GET response.
         */
        value: function get(endpoint, params) {
            return this._requestSkeleton(chakram.get, [endpoint, params]);
        }

        /**
         * Perform a POST request as this user.
         *
         * @param {string} endpoint API endpoint to make the request to.
         * @param {Object} data POST body.
         * @param {Object} [params] Request parameters.
         * @return {ChakramPromise} A promise which resolves to the Chakram POST response.
         */

    }, {
        key: 'post',
        value: function post(endpoint, data, params) {
            return this._requestSkeleton(chakram.post, [endpoint, data, params]);
        }

        /**
         * Perform a PUT request as this user.
         *
         * @param {string} endpoint API endpoint to make the request to.
         * @param {Object} data PUT body.
         * @param {Object} [params] Request parameters.
         * @return {ChakramPromise} A promise which resolves to the Chakram PUT response.
         */

    }, {
        key: 'put',
        value: function put(endpoint, data, params) {
            return this._requestSkeleton(chakram.put, [endpoint, data, params]);
        }

        /**
         * Perform a DELETE request as this user.
         *
         * @param {string} endpoint API endpoint to make the request to.
         * @param {Object} [data] DELETE body.
         * @param {Object} [params] Request parameters.
         * @return {ChakramPromise} A promise which resolves to the Chakram DELETE response.
         */

    }, {
        key: 'delete',
        value: function _delete(endpoint, data, params) {
            return this._requestSkeleton(chakram.delete, [endpoint, data, params]);
        }
    }]);

    return UserAgent;
}();

exports.Fixtures = Fixtures;
exports.Agent = Agent;