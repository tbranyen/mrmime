var mrmime = require("../../");

afterEach(function() {
  if (this.server) {
    this.server.close();
  }
});
