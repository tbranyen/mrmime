function indent(contents, spaces) {
  contents = contents || "";
  var lines = contents.split("\n");

  // Add one additional space for the 
  if (spaces !== "\t") {
    spaces = Array(spaces + 1).join(" ");
  }

  lines = lines.map(function(line) {
    if (line) {
      return spaces + line;
    }

    else {
      return "";
    }
  });

  return lines.join("\n");
}

module.exports = indent;
