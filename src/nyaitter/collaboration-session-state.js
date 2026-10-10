let active = false;
export const setCollaborationActive = value => {
    active = Boolean(value);
};
export const isCollaborationActive = () => active;
