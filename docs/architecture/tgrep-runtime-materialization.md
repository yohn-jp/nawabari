# Deterministic tgrep Runtime Materialization

Issue #307 establishes the implementation-only `tgrep` backend material used
by a later provider. It does not expose `tgrep` as a Nawabari command and does
not implement `rg` argument translation.

The backend requirement is explicit:

- requirement: `tgrep-backend`, package `tgrep`, version `1.0.8`;
- Nix installable:
  `github:NixOS/nixpkgs/0fcf36803fcc836b476126432b3334b293538476#tgrep`;
- upstream source: Microsoft `tgrep` tag `v1.0.8`, commit
  `b1d0fc2f6245cc78f1943e5864ceeab812452404`;
- executable relative to the resolved Nix package root: `bin/tgrep`;
- Linux x86_64-musl release archive SHA-256:
  `2e3de5b7735eb84aa150d3a48e8cff8f27c05795bfccb8b52c9bd8881f7225ce`.

`materializeTgrepRuntime()` fixes the Nixpkgs reference and package attribute,
then delegates closure resolution to #291. The result contains the exact
store-path executable source and #293 provider identity. Its projection has
only the bounded strict closure and no executable aliases; #295 can add its
own `rg` entrypoint using that source.

The current #292 FHS input accepts an explicit executable path but has no
version/source pin that can establish this backend contract. The tgrep FHS
entrypoint therefore returns `RUNTIME_MATERIALIZATION_MISSING`; it never
searches FHS roots or falls back to a host executable.

## Exact `--version` evidence

```text
tgrep 1.0.8
```

## Exact `--help` evidence

```text
Trigram-indexed grep — fast regex search for large codebases

Usage: tgrep [OPTIONS] [PATTERN] [PATH]... [COMMAND]

Commands:
  index        Build or rebuild the trigram index
  serve        Start the persistent search server
  search       Search for a pattern
  status       Show index and server status
  count-files  Count text files in a directory (fast walker, no indexing)
  help         Print this message or the help of the given subcommand(s)

Arguments:
  [PATTERN]  Search pattern (when not using a subcommand)
  [PATH]...  Root directories or files to search

Options:
  -i, --ignore-case
          Case-insensitive matching
  -s, --case-sensitive
          Force case-sensitive matching (overrides --smart-case)
  -S, --smart-case
          Smart case: case-insensitive if pattern is all lowercase
  -F, --fixed-strings
          Treat pattern as a literal string
  -w, --word-regexp
          Match whole words only
  -v, --invert-match
          Invert match: show lines that do NOT match
  -e, --regexp <REGEXP>
          Additional patterns (can be specified multiple times)
  -f, --file <PATTERN_FILE>
          Read patterns from a file (one per line)
  -U, --multiline
          Enable multiline matching (patterns may span line boundaries)
      --multiline-dotall
          Allow `.` to match a newline. Implies --multiline
  -l, --files-with-matches
          Print only filenames with matches
      --files-without-match
          Print files that do NOT match the pattern
  -c, --count
          Print match count per file
  -o, --only-matching
          Print only the matched parts of a line
  -m, --max-count <MAX_COUNT>
          Limit matches per file
      --files
          List files that would be searched (no search performed)
  -q, --quiet
          Suppress all output; exit code only (0 = match found, 1 = no match)
  -g, --glob <GLOB>
          Filter files by glob pattern (can be specified multiple times)
      --iglob <IGLOB>
          Like --glob, but case-insensitive
      --glob-case-insensitive
          Treat all --glob patterns as case-insensitive
  -t, --type <FILE_TYPE>
          Filter files by type (e.g., rust, py, js). Repeatable. Use --type-list to see all
  -T, --type-not <TYPE_NOT>
          Exclude files matching a type. Repeatable; takes precedence over --type
      --type-add <SPEC>
          Add or extend a type: `name:glob` or `name:include:type1,type2`
      --type-clear <NAME>
          Remove all globs for a type before applying --type-add
      --type-list
          Print all supported file types
      --max-filesize <NUM>
          Ignore files larger than NUM bytes (suffixes K, M, G allowed). Defaults to 64M; use --no-max-filesize for no limit
      --no-max-filesize
          Apply no file size limit, as ripgrep does
  -E, --encoding <ENCODING>
          Text encoding to use: `auto` (BOM sniffing), `none`, or a label like `utf-16le`
      --no-encoding
          Reset --encoding back to `auto`
  -a, --text
          Search binary files as if they were text
  -A, --after-context <AFTER_CONTEXT>
          Lines of context after each match
  -B, --before-context <BEFORE_CONTEXT>
          Lines of context before each match
  -C, --context <CONTEXT>
          Lines of context before and after each match
  -H, --with-filename
          Print the file name for each match (default behavior, ripgrep compatibility)
  -I, --no-filename
          Suppress filenames in output
  -n, --line-number
          Show line numbers (default behavior, ripgrep compatibility)
  -N, --no-line-number
          Suppress line numbers in output
      --heading
          Group matches by file with heading
      --no-heading
          Don't group matches; flat output
      --json
          JSON output (one object per line)
      --vimgrep
          Output in vim-compatible format (file:line:col:content)
      --color <COLOR>
          Color mode: auto, always, or never [default: auto]
  -0, --null
          Use NUL byte as filename separator (for xargs -0)
      --trim
          Trim leading/trailing whitespace from each line
      --stats
          Print query plan and timing stats
      --no-index
          Skip the index, grep all files directly
      --index-path <INDEX_PATH>
          Custom index directory
  -., --hidden
          Include hidden files and directories
      --no-ignore
          Don't respect .gitignore or p4ignore.ini files
  -L, --follow
          Follow symbolic links while searching
      --no-messages
          Suppress error messages about nonexistent or unreadable files
  -u, --unrestricted...
          Unrestricted search. -u = no-ignore, -uu = +hidden, -uuu = +binary
      --binary
          Search binary files, reporting a note instead of printing their lines
  -x, --line-regexp
          Only match when the whole line matches the pattern
  -P, --pcre2
          Use the PCRE-style engine, enabling lookaround and backreferences
      --engine <ENGINE>
          Regex engine to use: default, pcre2, or auto [default: auto]
      --pcre2-version
          Print the PCRE-style engine version and exit
      --no-unicode
          Disable Unicode-aware matching
      --regex-size-limit <NUM>
          Upper size limit for the compiled regex (suffixes K, M, G allowed)
      --dfa-size-limit <NUM>
          Upper size limit for the regex DFA cache (suffixes K, M, G allowed)
  -r, --replace <TEXT>
          Replace each match with TEXT. Capture groups are available as $1, ${name}
      --passthru
          Print both matching and non-matching lines
      --stop-on-nonmatch
          Stop searching a file after a line that does not match
      --column
          Show the column number of the first match on each line
      --no-column
          Don't show column numbers
  -b, --byte-offset
          Print the 0-based byte offset of each output line
  -M, --max-columns <NUM>
          Don't print lines longer than NUM bytes
      --max-columns-preview
          Print a truncated preview instead of suppressing a long line entirely
      --count-matches
          Count individual matches instead of matching lines
      --include-zero
          Print a count of zero for files with no match
  -p, --pretty
          Alias for --color always --heading --line-number
      --context-separator <SEP>
          String printed between non-contiguous context blocks
      --no-context-separator
          Never print a context separator
      --field-match-separator <SEP>
          Separator between the path/line/column fields of a matching line
      --field-context-separator <SEP>
          Separator between the path/line/column fields of a context line
      --path-separator <SEP>
          Character to use as the path separator in output
      --sort <SORTBY>
          Sort results. Choices: none, path, modified, accessed, created
      --sortr <SORTBY>
          Sort results in descending order. Same choices as --sort
      --sort-files
          Deprecated alias for --sort path
      --max-depth <NUM>
          Descend at most NUM directories below each search path
      --one-file-system
          Don't cross file system boundaries
      --ignore-file <PATH>
          Read extra ignore globs from PATH. Repeatable; later files take precedence
      --ignore-file-case-insensitive
          Match --ignore-file globs case-insensitively
      --no-ignore-dot
          Don't respect .ignore files
      --no-ignore-exclude
          Don't respect .git/info/exclude
      --no-ignore-files
          Don't respect --ignore-file arguments
      --no-ignore-global
          Don't respect the global gitignore
      --no-ignore-messages
          Suppress messages about unparseable ignore files
      --no-ignore-parent
          Don't respect ignore files in parent directories
      --no-ignore-vcs
          Don't respect .gitignore files
      --no-require-git
          Respect .gitignore files even outside a git repository
  -j, --threads <NUM>
          Number of threads to use. tgrep sizes its pool automatically
      --mmap
          Accepted for compatibility; tgrep always reads files directly
      --no-mmap
          Accepted for compatibility; tgrep always reads files directly
      --line-buffered
          Flush output on every line
      --block-buffered
          Buffer output in blocks (the default when not writing to a terminal)
      --no-config
          Accepted for compatibility; tgrep reads no configuration file
      --colors <SPEC>
          Accepted for compatibility; tgrep's colors are not configurable yet
      --debug
          Print debug messages to stderr (implies `--stats`)
      --trace
          Print verbose trace messages to stderr (implies `--stats`)
      --crlf
          Accepted for compatibility; tgrep always strips a trailing `\r`
      --no-crlf
          Accepted for compatibility; tgrep always strips a trailing `\r`
  -z, --search-zip
          Not supported: tgrep does not decompress archives before searching
  -h, --help
          Print help
  -V, --version
          Print version
```
