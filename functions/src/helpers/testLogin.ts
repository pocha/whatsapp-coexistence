// A fixed login for reviewers (Meta's App Review needs a way to sign in without receiving a
// WhatsApp message). For this one number the code is always TEST_LOGIN.code and no message is
// sent; every other number gets a real one-time code as usual.
//
// Treat the account behind it as public: give it only demo data, never a real customer's number.
// Delete this file's values (or the lines in otp.ts that read them) once review is done.
// `phone` is digits only, as the login page normalises numbers (+1 234 567 8901).
export const TEST_LOGIN = { phone: '12345678901', code: '123456' };
