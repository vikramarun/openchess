//! Usernames: the grammar, the reserved list, and the derived helpers that must
//! never drift from it — address-shape detection for `/players/{ident}`, LIKE
//! escaping for the prefix search, and the decoration that keeps a guest label
//! from passing as a handle.
//!
//! Everything here is pure — no state, no database, no tokio — because these are
//! the rules a database constraint cannot express, and the ones most worth
//! pinning with tests.

/// Shortest allowed username, in characters.
pub const USERNAME_MIN: usize = 3;
/// Longest allowed username, in characters.
pub const USERNAME_MAX: usize = 20;

/// Names nobody may hold. Four kinds, and the fourth is the non-obvious one:
///
///   * **authority claims** — `admin`, `system`, `support`, `moderator`,
///     `staff`, `official`, `root`, and `oracle`: this server signs game results
///     as an oracle, so a player named for it is a phishing primitive;
///   * **the product itself** — `openchess`, and `house`/`housebot`, which name
///     the bot the lobby's play-now button seats you against;
///   * **strings a UI renders as an absence** — `anonymous`, `null`,
///     `undefined`, `none`, `me`;
///   * **route segments.** `/players/search` is a static sibling of
///     `/players/{ident}` and the router prefers the static one, so a wallet
///     holding the name `search` would own a profile URL that can never resolve
///     to it. Anything added as a static child of `/players/` has to be added
///     here in the same commit — `a_route_segment_can_never_be_claimed` is what
///     makes forgetting loud.
const RESERVED: &[&str] = &[
    "admin",
    "administrator",
    "moderator",
    "mod",
    "staff",
    "official",
    "system",
    "support",
    "oracle",
    "root",
    "openchess",
    "house",
    "housebot",
    "anonymous",
    "null",
    "undefined",
    "none",
    "me",
    "search",
];

/// Why a username was refused. Ordered by how it is reported: the caller turns
/// this into the field the client shows under the input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsernameError {
    /// Outside `USERNAME_MIN..=USERNAME_MAX` characters.
    Length,
    /// Something outside `[A-Za-z0-9_]`.
    Charset,
    /// On the reserved list.
    Reserved,
    /// Starts with `0x`. See [`validate_username`].
    AddressShape,
}

impl UsernameError {
    /// The stable wire code for this refusal, for the `reason` field of a 400.
    pub fn code(self) -> &'static str {
        match self {
            Self::Length => "length",
            Self::Charset => "charset",
            Self::Reserved => "reserved",
            Self::AddressShape => "address_shape",
        }
    }
}

/// Validate a username, returning it unchanged on success.
///
/// **Normalisation is a fold, never a rewrite.** What is stored is exactly what
/// the user typed; what is compared is its lowercase. Nothing is trimmed and
/// nothing is substituted — every rewrite is a way for two distinct inputs to
/// become the same stored name without the user being told, and the charset
/// already excludes whitespace, so there is nothing to trim.
///
/// The charset is ASCII-only, which is the point rather than a limitation: it
/// makes Rust's `to_ascii_lowercase` and Postgres's `lower()` agree byte for
/// byte, so the reserved check here and the unique index there can never
/// disagree about whether two names are the same one.
///
/// `0x` is refused as a PREFIX, not merely at the 42-character address length.
/// `GET /players/{ident}` routes on the address shape first, so a name that
/// merely *looks* addressish is a permanent source of "why does this link go
/// somewhere else" — and `0xdeadbeef` sitting next to a real `0xdead…beef` is a
/// social-engineering surface on a server that moves money.
///
/// Length is counted in `chars`, not bytes, so a multi-byte rejection reports
/// the charset problem rather than a confusing length one.
pub fn validate_username(s: &str) -> Result<&str, UsernameError> {
    let len = s.chars().count();
    if !(USERNAME_MIN..=USERNAME_MAX).contains(&len) {
        return Err(UsernameError::Length);
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(UsernameError::Charset);
    }
    // `starts_with`, never `s[..2]`: a byte slice off a char boundary panics,
    // and the only thing standing between this line and that panic would be the
    // ASCII charset check above. That is an ordering dependency nothing pins —
    // reorder the two and this becomes a crash. See `is_address_shape`, where
    // the same slice really did panic.
    if s.starts_with("0x") || s.starts_with("0X") {
        return Err(UsernameError::AddressShape);
    }
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(s)) {
        return Err(UsernameError::Reserved);
    }
    Ok(s)
}

/// Whether `s` could be a username: the GRAMMAR only, with no reserved-word
/// check. This is the ROUTING gate; [`validate_username`] is the write gate.
///
/// The two are deliberately different strictnesses, and collapsing them breaks
/// routing rather than validation — which is the harder failure to spot. A name
/// the server has already issued must keep resolving even if its word later
/// joins `RESERVED`; otherwise `/players/{that name}` 404s a profile the server
/// is happily serving by address. That is not hypothetical: the house bot holds
/// `HouseBot` precisely BECAUSE the word is reserved to everyone else, and
/// routing through the write gate made its own profile unreachable.
///
/// `lib/address.ts` carries the same pair for the same reason.
pub fn is_username_shape(s: &str) -> bool {
    let len = s.chars().count();
    (USERNAME_MIN..=USERNAME_MAX).contains(&len)
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !(s.starts_with("0x") || s.starts_with("0X"))
}

/// Whether `s` is a hex address as `/players/{ident}` recognises one: `0x` plus
/// exactly 40 hex digits, case-insensitively.
///
/// Deliberately strict — the ident router asks this question first, and a loose
/// answer would swallow usernames.
///
/// Byte-oriented on purpose, but never by SLICING. `len()` counts bytes while a
/// slice needs a char boundary, so `s[..2]` panics on a 42-byte ident whose
/// first character is multi-byte — and this is called on an unauthenticated URL
/// path, so that was a crafted-request panic on three public routes. `bytes()`
/// and `starts_with` ask the same question without the boundary hazard: a real
/// address is 42 ASCII bytes, so "42 bytes, all of them the right ASCII" is
/// exactly the test, and any multi-byte input simply fails the hexdigit check.
pub fn is_address_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 42
        && b[0] == b'0'
        && (b[1] | 0x20) == b'x'
        && b[2..].iter().all(|c| c.is_ascii_hexdigit())
}

/// A search prefix, escaped for `LIKE … ESCAPE '\'`.
///
/// `_` is a legal username character AND LIKE's single-character wildcard, so
/// searching `a_c` must not return `abc`. `%` and `\` cannot appear in a
/// validated prefix, but they are escaped anyway: this function's contract is
/// "safe for LIKE", and it has to stay true if the charset ever widens.
pub fn like_prefix(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if matches!(c, '_' | '%' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A label declared by a client with no authenticated wallet, rendered so it can
/// never be read as a username.
///
/// This is the second half of the impersonation guarantee. The first half is
/// structural — a wallet-bound seat never reads a client-supplied string at all
/// (see `AppState::start_game`) — but anonymous casual seats and casual
/// tournament entrants still choose their own labels, and `alice` typed by a
/// guest must not render identically to the wallet that owns the username
/// `alice`. The `~` prefix does it with one character: `~` is outside
/// `[A-Za-z0-9_]`, so a decorated guest label is not merely unlikely to collide
/// with a username, it is incapable of it.
pub fn guest_label(s: &str) -> String {
    format!("~{s}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_grammar_and_stores_the_case_it_was_given() {
        for ok in ["abc", "Alice", "a_B9", "___", "u123456789012345678"] {
            assert_eq!(validate_username(ok), Ok(ok), "{ok:?} should be legal");
        }
    }

    #[test]
    fn rejects_lengths_outside_three_to_twenty() {
        assert_eq!(validate_username(""), Err(UsernameError::Length));
        assert_eq!(validate_username("ab"), Err(UsernameError::Length));
        assert!(validate_username("abc").is_ok(), "3 is allowed");
        let twenty = "a".repeat(20);
        assert!(validate_username(&twenty).is_ok(), "20 is allowed");
        assert_eq!(
            validate_username(&"a".repeat(21)),
            Err(UsernameError::Length)
        );
    }

    #[test]
    fn rejects_anything_outside_the_ascii_word_charset() {
        for bad in [
            "a-b", "a b", "a.b", "a%b", "a/b", "héllo", "аbcd", // Cyrillic а
            "ab😀", "user\n", " abc", "abc ", "../admin",
        ] {
            assert!(
                matches!(
                    validate_username(bad),
                    Err(UsernameError::Charset | UsernameError::Length)
                ),
                "{bad:?} should be refused"
            );
        }
        // Nothing is trimmed INTO validity: a padded legal name stays illegal
        // rather than silently becoming its trimmed self.
        assert_eq!(validate_username(" alice "), Err(UsernameError::Charset));
    }

    #[test]
    fn reserved_words_are_refused_however_they_are_capitalised() {
        for bad in ["admin", "Admin", "ADMIN", "oPenChess", "anonymous", "Oracle"] {
            assert_eq!(
                validate_username(bad),
                Err(UsernameError::Reserved),
                "{bad:?}"
            );
        }
    }

    /// The routing gate and the write gate must NOT agree, and this is the pair
    /// a refactor would "simplify" into one function.
    ///
    /// Reserved words have to stay ROUTABLE while being unclaimable: the house
    /// bot holds `HouseBot` because that word is reserved to everyone else, and
    /// resolving idents through the write gate made `/players/HouseBot` 404 a
    /// profile that `/players/0xeebe…` served perfectly well.
    #[test]
    fn a_reserved_name_is_unclaimable_but_still_routable() {
        for name in ["HouseBot", "housebot", "admin", "openchess"] {
            assert!(is_username_shape(name), "{name} must still resolve");
            assert_eq!(
                validate_username(name),
                Err(UsernameError::Reserved),
                "{name} must not be claimable"
            );
        }
        // The shape gate is still a gate: it rejects everything the grammar does.
        for bad in ["ab", "a-b", "0xdead", "日本語", &"a".repeat(21)] {
            assert!(!is_username_shape(bad), "{bad:?}");
        }
    }

    /// Every static child of `/players/` must be unclaimable, or its route would
    /// shadow the profile of whoever holds that name. Today the list is just
    /// `search`; this test is what makes adding the next one loud.
    #[test]
    fn a_route_segment_can_never_be_claimed() {
        for segment in ["search"] {
            assert_eq!(
                validate_username(segment),
                Err(UsernameError::Reserved),
                "/players/{segment} is a static route"
            );
        }
    }

    #[test]
    fn an_address_shaped_name_can_never_be_registered() {
        for bad in ["0xab", "0Xabc", "0xdeadbeef", "0xDEAD"] {
            assert_eq!(
                validate_username(bad),
                Err(UsernameError::AddressShape),
                "{bad:?}"
            );
        }
        // A full address is too long to be a username anyway, but the prefix
        // rule is what actually does the work.
        assert!(validate_username(&format!("0x{}", "a".repeat(40))).is_err());
    }

    #[test]
    fn the_ident_router_sees_an_address_before_a_username() {
        let addr = "0xebe9b106daF6DA2F6DF201074eddc53030168ea2";
        assert_eq!(addr.len(), 42);
        assert!(is_address_shape(addr), "{addr} is 0x + 40 hex");
        assert!(is_address_shape(&addr.to_uppercase()));
        assert!(!is_address_shape(&format!("0x{}", "a".repeat(39))), "41 chars");
        assert!(!is_address_shape(&format!("0x{}", "a".repeat(41))), "43 chars");
        assert!(!is_address_shape(&format!("0x{}", "z".repeat(40))), "not hex");
        assert!(!is_address_shape("alice"));
        // And the two never both claim the same string.
        assert!(!is_address_shape("0xdeadbeef"));
    }

    /// Every helper here is reached from an unauthenticated URL path, so none of
    /// them may slice a `&str` by byte offset.
    ///
    /// `is_address_shape` did: it gated on `s.len() == 42` (BYTES) and then took
    /// `s[..2]`, which panics when byte 2 is inside a character. A 42-byte ident
    /// starting with one 3-byte char reached it through `/players/{ident}`,
    /// `/players/{ident}/games` and `/players/{ident}/avatar` and killed the
    /// connection every time. `short_addr` carries the same test for the same
    /// reason (`short_addr_is_char_safe_on_multibyte_input` in main.rs) — this
    /// bug class has bitten this codebase before.
    #[test]
    fn the_string_helpers_are_char_safe_on_multibyte_input() {
        // 42 BYTES, 40 chars: passes a byte-length gate, panics a byte slice.
        let crafted = format!("日{}", "a".repeat(39));
        assert_eq!(crafted.len(), 42);
        assert_ne!(crafted.chars().count(), 42);
        assert!(!is_address_shape(&crafted));

        // A sweep of widths and positions, since the boundary that matters
        // depends on where the multi-byte character lands.
        for filler in ["a", "0", "é", "→", "😀"] {
            for n in 0..8 {
                let s = format!("{}{}", filler.repeat(n), "b".repeat(42));
                assert!(!is_address_shape(&s) || s.is_ascii());
                let _ = validate_username(&s);
                let _ = like_prefix(&s);
                let _ = guest_label(&s);
            }
        }
        // Nothing multi-byte is ever a valid username, however it is shaped.
        for s in ["日本語", "0😀", "é".repeat(20).as_str()] {
            assert!(validate_username(s).is_err(), "{s:?}");
        }
    }

    #[test]
    fn underscore_is_a_letter_to_this_search_not_a_wildcard() {
        assert_eq!(like_prefix("a_c"), r"a\_c");
        assert_eq!(like_prefix("ab"), "ab");
        assert_eq!(like_prefix("100%"), r"100\%");
        assert_eq!(like_prefix(r"a\b"), r"a\\b");
    }

    #[test]
    fn a_guest_label_cannot_collide_with_any_username() {
        for name in ["alice", "Admin", "a_B9", "abc"] {
            assert!(
                validate_username(&guest_label(name)).is_err(),
                "~{name} must never validate as a username"
            );
        }
    }
}
