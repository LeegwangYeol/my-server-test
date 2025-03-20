export const parsePhoneNumber = (phoneNumber: string): string =>
  phoneNumber.replace(/[^\d+]/g, "");
