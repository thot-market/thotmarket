# Private source retention

New private uploads, inference captures, coding-agent captures and OpenRouter recordings are kept until their uploader deletes them by default. An explicit `privateRetentionDays` configuration still imposes its configured lifetime.

Internally, no automatic expiry is represented by `9999-12-31T23:59:59.999Z`, preserving existing ISO deadline comparisons. The library displays “Kept until you delete it”, not a distant date.

Existing records retain their original deadlines. Continuing an existing capture preserves its deadline. This change does not restore expired objects or change a seller’s signed licence. Purchased release copies still expire under their agreed licence; deleting a source does not revoke already funded copies before their existing deadline.
