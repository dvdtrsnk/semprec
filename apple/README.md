# Apple app

The iOS app must declare `applinks:<domain>` (the value of `SEMPREC_DOMAIN`) in its Associated
Domains entitlement. The domain then serves `/.well-known/apple-app-site-association`, rendered by
`deploy/provision.sh` from `SEMPREC_APPLE_TEAM_ID` and `SEMPREC_IOS_BUNDLE_ID`, which associates
only the password-reset link (`/?page=password-reset`) with the app. The invitation link is not a
Universal Link.
