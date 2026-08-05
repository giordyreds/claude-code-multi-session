# Source this file to make the `ccp` shell function available:
#
#   source /path/to/shell/ccp.sh
#   ccp use work
#   ccp use          # no Alias: shows an interactive picker on stderr (ticket #9)
#
# Per ADR-0004, a child process cannot modify its parent shell's environment, so Binding can
# only happen by this function `eval`-ing output the `ccp` program prints to stdout. `command
# ccp` (not bare `ccp`) reaches the real executable instead of recursing into this function.
#
# `ccp run <alias> -- <command>` (ticket #11) needs none of this: it never modifies the calling
# shell, only the command it spawns, so it works unmodified in a non-interactive shell that never
# sourced this file at all — it falls through to the plain `command ccp "$@"` case below.

ccp() {
  if [ "$1" = "use" ]; then
    local __ccp_output
    __ccp_output="$(command ccp "$@")"
    local __ccp_status=$?
    # Only `eval` on success: a non-zero exit means `ccp` printed nothing to bind (ADR-0004), so
    # evaluating here would either be a no-op or, worse, risk running stray output as code.
    if [ "$__ccp_status" -eq 0 ] && [ -n "$__ccp_output" ]; then
      eval "$__ccp_output"
    fi
    return "$__ccp_status"
  fi

  command ccp "$@"
}

# Prompt indicator (ticket #10): always shows which Profile a shell is bound to, since being
# wrong about that is the failure mode this whole tool exists to prevent. Reads
# `CLAUDE_CONFIG_DIR` fresh on every prompt draw rather than caching an Alias at source time, so
# the segment updates immediately after `ccp use` with no new shell needed — it just reflects
# whatever Binding last set.
__ccp_prompt_segment() {
  if [ -n "$CLAUDE_CONFIG_DIR" ]; then
    printf '[%s] ' "$(basename "$CLAUDE_CONFIG_DIR")"
  else
    # Mirrors registry.ts's DEFAULT_INSTALL_ALIAS: an unbound shell must never look the same as a
    # missing indicator (ADR-0003).
    printf '[(default)] '
  fi
}

# Extends PS1 rather than replacing it, and only once: re-sourcing this file leaves an
# already-extended PS1 untouched instead of stacking a second copy of the segment.
case "$PS1" in
  *'$(__ccp_prompt_segment)'*) ;;
  *)
    PS1='$(__ccp_prompt_segment)'"$PS1"
    # Command substitution in PS1 is automatic in bash but opt-in in zsh.
    [ -n "$ZSH_VERSION" ] && setopt PROMPT_SUBST
    ;;
esac
