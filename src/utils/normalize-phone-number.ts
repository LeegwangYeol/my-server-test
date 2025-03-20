import { PhoneNumberUtil, PhoneNumberFormat } from "google-libphonenumber";

/**
 * @param phoneNumber
 * @returns
 */
export const normalizePhoneNumber = (phoneNumber: string): string => {
  const phoneUtil = PhoneNumberUtil.getInstance();
  const defaultRegion = "KR";
  return phoneUtil.format(
    phoneUtil.parseAndKeepRawInput(phoneNumber, defaultRegion),
    PhoneNumberFormat.E164,
  );
};
