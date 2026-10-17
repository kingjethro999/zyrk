# Security policy

zyrk is pre-release software under active construction. There is no stable or
long-term-support release line. Security fixes target current development and
the latest published pre-release; older versions do not receive promised
backports. No response or remediation deadline is guaranteed.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/kingjethro999/zyrk/security/advisories/new).
Private reporting is enabled for this repository. Please keep exploit details,
credentials, and affected users' data out of public issues and discussions.

If the form is unavailable, use the contact links on
[the maintainer's profile](https://github.com/kingjethro999) to request a private
reporting channel. A public request should contain no vulnerability details.

Include the affected version or commit, Node.js version, OS and filesystem,
a minimal reproduction using disposable fixtures, expected and observed
behavior, and the likely impact. Describe relevant registry, script-policy,
store, and command options. Redact tokens, credentials, private package names,
and personal filesystem paths. A report should not require access to a real
account or production data to reproduce.

The maintainer will assess the report and coordinate fixes and disclosure when
possible. Please allow coordination before publishing a working exploit. This
project offers no bug bounty or guaranteed response time.

## Scope and operational limits

Reports involving integrity verification, archive extraction, credentials,
shared-store mutation, project isolation, subprocess cleanup, and portable
exports are useful. The shared store is scoped to one OS account. Package code
runs with that account's permissions when explicitly invoked or approved;
read-only modes and subprocess supervision are not a sandbox. Compatibility
and platform support are limited to the cases documented and tested in the
repository.

Scheduled dependency audits and Dependabot updates supplement review. An audit
service failure is reported as unavailable and fails the scheduled check;
only a valid successful zero-finding report counts as clean. A clean dependency
audit does not establish that zyrk or its dependencies are free of vulnerabilities.
