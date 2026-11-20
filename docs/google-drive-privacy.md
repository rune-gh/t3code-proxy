# Google Drive upload privacy policy

This policy covers the Google OAuth client that a t3code-proxy hub uses to upload its trace archive to Google Drive.

## What the client accesses

The client requests only the `https://www.googleapis.com/auth/drive.file` scope. With that scope it can see and change only the files it created. It cannot read, list or change anything else in the Drive account.

## What it uploads

The hub uploads two kinds of file to a single folder in the Drive account of the person who runs the hub:
- sealed trace-archive segments, compressed and encrypted with [age](https://age-encryption.org) to recipient keys the owner chooses;
- the small manifests that describe them.

Google cannot read the segments. Only the holder of a matching age identity can decrypt them. The format is described in [trace-archive.md](trace-archive.md).

## Who receives data

No one else. The hub runs on hardware the owner controls and talks only to Google Drive. The project behind the OAuth client collects no data, runs no servers, and shares nothing with third parties. The client is used by the owner's own hub and is not offered to other users.

## Removing data and access

Delete the files from the Drive folder at any time. To revoke the hub's access, remove the app at https://myaccount.google.com/permissions.
