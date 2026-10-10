'use strict';

const express = require('express');

function createRouter() {
  const target = express.Router();
  return new Proxy(target, {
    get(router, property) {
      const method = String(property).toLowerCase();
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        return (spec, ...handlers) => router[method](spec.path, ...handlers);
      }
      return router[property];
    },
  });
}

module.exports = {createRouter};
