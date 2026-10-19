// Login codes go out through an API that flags a repeated message to the same
// recipient as a duplicate. One random fact per message keeps each one different.
// Three facts per how-to page (and the capabilities page); each restates something
// that page already says, so the pointer to the how-to section holds up.
export const OTP_FACTS: string[] = [
  // create-meta-business-portfolio-add-whatsapp-number
  'You need a Meta business portfolio to use the WhatsApp API, but it can stay unverified.',
  'One Facebook account can own several business portfolios.',
  'Your WhatsApp Business app must be installed and logged in before you link the number to a portfolio.',
  // get-whatsapp-api-for-free
  'Meta describes the token from the WhatsApp setup page as a permanent access token.',
  'Pick the "Connect with customers through WhatsApp" use case when you create the Meta app.',
  'An API for your own number runs on Standard Access, so no App Review is needed.',
  // get-whatsapp-api-access-in-5-minutes
  'Coexistence keeps the WhatsApp Business app and the API working on one number.',
  'With coexistence, your contacts and chat history sync to the API once, within 24 hours.',
  'Coexistence needs no verified business.',
  // move-whatsapp-api-between-providers
  'Under Meta\'s new account model, templates belong to the Messaging account, not the phone number.',
  'Disconnecting from a provider does not delete your templates.',
  'You can only move or share a WhatsApp account that your own business portfolio owns.',
  // questions-to-ask-whatsapp-api-provider
  'Meta charges per delivered message, and never for messages your customers send.',
  'An unverified business starts at 250 customers a day, and messaging limits count customers, not messages.',
  'Ask whether your provider supports coexistence: the number has to be on the Business app when it connects.',
  // deregister-whatsapp-number-from-provider
  'De-registering a number does not delete it or its chat history.',
  'A coexistence number is disconnected in the Business app: Settings, Account, Business Platform.',
  'Registering a number for the API needs a six-digit PIN.',
  // whatsapp-number-registration-and-pin
  'The six-digit registration PIN is one you choose yourself.',
  'Meta can pause a template after negative feedback from customers.',
  'Template review can take up to 24 hours.',
  // connect-watobot-to-ai-tool
  'Watobot never stores your messages.',
  'Your Meta token is encrypted with your Watobot key, and only a hash of that key is kept.',
  'Your Watobot key is created in your browser and shown once.',
  // capabilities
  'A free-form reply is only allowed within 24 hours of the customer\'s last message.',
  'Messages you type in the Business app reach your API as echoes.',
  'Watobot shows Meta\'s account alerts and sending limits on your dashboard.',
];

export function pickOtpFact(random: () => number = Math.random): string {
  return OTP_FACTS[Math.floor(random() * OTP_FACTS.length)];
}

export function otpMessage(code: string, fact: string): string {
  return (
    `Your Watobot OTP to login is ${code}. It expires in 5 minutes. Don't share this code with anyone.\n\n` +
    `Fun fact: ${fact}\nFor more such interesting facts, check the how-to section of the Watobot website.`
  );
}
